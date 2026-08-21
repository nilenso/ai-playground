# Plan — agent failure taxonomy and the new evaluator

Status: **agreed, not yet built.** All three arms paused. This supersedes the
fix plan I issued on 2026-08-21 morning.

---

## 0. The question

> **What makes a CLI interface agent-friendly?**

That is what we are trying to answer. It is a general question with a general
answer — a set of design properties that hold beyond botmap.

Everything else is instrumentation. botmap is the **subject we experiment on**,
not the thing we are shipping. GEPA, the three arms, the question bank and the
evaluator all exist to produce evidence for the question above.

Three consequences:

- **We do not touch `botmap/evals/`.** Not ours, not the goal. We build our own
  evaluator; botmap's stays exactly as it is.
- **A run that moves no score can still be a success.** If it tells us which CLI
  properties let an agent recover unaided, that is the result we came for.
- **The deliverable is a document, not a patch.** See section 0.1.

When something is ambiguous, ask *"does this teach us what makes a CLI
agent-friendly?"* — not *"does this make the number go up?"*

---

## 0.1 The deliverable

`docs/agent-friendly-cli.md` — a living list of **design properties, each backed
by a measurement**. This is the output of the whole project. Everything in the
rest of this plan exists to add evidenced lines to that file.

Each entry has the same shape. **The change and its effect are mandatory** — a
property observed but never fixed is a hypothesis, not an answer.

```
PROPERTY    what an agent-friendly CLI does
VIOLATION   the failure class that appears when it is missing
STATUS      hypothesis | confirmed | refuted

BEFORE      the measured trace of an agent defeated by its absence
            - what it typed, what came back, how many commands it burned
            - what it finally concluded (often: a confident wrong answer)

CHANGE      the actual change, and WHICH LEVER it was
            - lever: tool | instructions
            - the diff, or the exact text added
            - why that lever and not the other

AFTER       the measured trace of the same question, same conditions,
            with the change in place
            - did the agent recover unaided?
            - commands before/after, turns before/after
            - did it reach the right answer?

VERDICT     confirmed | refuted, and the delta that supports it
```

### Two tiers of evidence, and why the distinction matters

Not every property can be confirmed cheaply. There are two levels, and we should
be explicit about which one an entry has:

**Tier 1 — the information existed and was not surfaced.** The differential
probe proves this. Cheap: CLI calls only, no model spend.
*Example: `--class recreation` → 0, `subtype=recreation` → 86. The tool knew.*
This makes a property a **candidate**. It does not confirm it.

**Tier 2 — we surfaced it, and the agent did better.** Requires a paired run:
same question, same conditions, before and after the change.
*Example: with the near-match hint on `count`, the agent reaches `bus_station`
in 1 command instead of 7 — or does not, in which case the property is refuted.*
Only Tier 2 **confirms**.

Tier 1 is how we find candidates cheaply. Tier 2 is how we spend our budget
deliberately, on the candidates most worth proving.

**A refuted property is a real result.** If we add a hint and the agent ignores
it anyway — class F — then "name the fix" was not the missing property, and
something else is. That finding is as valuable as a confirmation, and cheaper
than shipping a fix nobody benefits from.

### Which lever is part of the answer, not an implementation detail

Every entry records whether the fix went in the **tool** or the
**instructions**, because "what makes a CLI agent-friendly?" has a legitimate
answer of the form *"nothing in the CLI — tell the agent in the prompt."*

If most confirmed properties turn out to be instruction-side, that is a finding
about where agent-facing design effort should go. If they are mostly tool-side,
that is the opposite finding. We cannot know without recording it every time.

### The structural insight this exposes

**The failure taxonomy and the answer are the same list, seen from opposite
sides.** Every failure class is a design property being violated:

| Failure class | The property it violates |
|---|---|
| C `c-vocabulary` | never return empty without saying why |
| C `c-truncated` | never silently truncate output |
| C `c-dropped-input` | never silently discard input |
| C `c-wrong-column` | if a value exists elsewhere, say where |
| C `c-wrong-entity` | confirm what you resolved, not just that you resolved |
| B (present) | name the fix, not just the problem |
| D | emit progress on long operations |
| F | a hint the agent ignores is not a hint that worked |

So the classifier is not just a scorer. **It is the instrument, and its readings
are candidate design properties.** That is why the taxonomy has to be right
before anything else runs.

### The draft answer, from evidence we already have

These come from the 20 measured defects. Every one is currently
**STATUS: hypothesis** — we have the BEFORE trace for each and no AFTER for any.
They become the work queue: each needs a change and a paired run before it can
be claimed as an answer.

1. **Never return an empty result without saying why.** A zero that could mean
   "none exist" or "you asked wrong" is the most damaging output a CLI can
   produce. *(`bus_stop` → 0; `landuse --class beach` → 0 while 67 exist under
   `land`)*
2. **Name the fix, not just the problem.** *(the near-match hint fires on
   `places` but not on `count`, where the docs tell agents to start — the agent
   ran seven commands hunting a name the tool already knew)*
3. **Never silently discard input.** *(`--class trunk --class primary` keeps
   only the last; no warning)*
4. **Never silently truncate output.** *(`--top 200` omits `bus_station`;
   `--top 5000` returns all 963 — the agent concluded the category did not
   exist)*
5. **Make discovery a first-class operation.** *(no `categories --search`, so
   finding a slug means guessing `--top N` and grepping)*
6. **Advertise only values that work.** *(`--class` help lists `subtype` values
   that return zero)*
7. **Confirm what you resolved.** *(`where "Malta, MT"` → Malta, **Montana**,
   silently)*
8. **Emit progress on long operations.** *(19m42s of total silence reads as a
   hang; the agent abandons a correct command)*
9. **Recovery advice must actually work.** *(`no_match` recommends a command
   that takes ten minutes and prints nothing)*
10. **One obvious spelling should work.** *(`--json` only functions before the
    subcommand, and breaks the first example an agent reads)*

Note what these have in common: **almost none are about the CLI's
functionality.** The commands work. What is missing is the CLI *telling the
agent what happened* — which suggests the answer to our question is mostly about
observability and self-description, not features. That is a hypothesis the runs
should test.

---

## 1. Decisions taken

| # | Question | Decision |
|---|---|---|
| 1 | Three axes or a richer label list? | **Three axes.** Changing `record.json` is fine — write a **new** record format, keep the old one untouched. |
| 2 | Build the differential probe? | **Yes.** It is how we learn whether an agent *could* have recovered, and what would have let it. |
| 3 | Agent-side failure in scope? | **Record it.** We want to know whether hints actually help the agent self-correct. Decide what to do with it next iteration. |
| 4 | Which exam first? | **Neither — build a new shared evaluator module** used by all three arms. |
| 5 | Sabotage validation? | **Yes.** |
| 6 | Existing runs? | **Leave them alone.** No re-scoring, no rewriting history. New runs write new records. |

We accept that new numbers will not be comparable to old ones. That is a
deliberate cost, taken once.

---

## 2. Architecture — one shared evaluator

Today the scoring logic exists twice, with incompatible contracts (botmap's
`classify_error` returns `None` for clean; autoresearch's `classify` returns
`"clean"` and never `None`). That drift is how we ended up with the same bug in
two places.

**New module: `autoresearch/agenteval/`.** One implementation, imported by all
three arms.

```
autoresearch/agenteval/
  contract.py    the record schema — written FIRST, everything else builds to it
  taxonomy.py    three-axis classifier
  probe.py       differential probe (the class-C detector)
  score.py       class-weighted scoring
  explain.py     turns classified failures into fix instructions for the proposer
  sabotage.py    fixtures that prove the classifier actually fires
```

`botmap/evals/` is untouched and stays on its own path. If we later want to
compare, we run our evaluator over botmap's recorded attempts — we do not edit
theirs.

---

## 3. The data contract — build this first

Everything else depends on this shape, so it lands before anyone writes a
classifier or a scorer. **Nobody starts their component until `contract.py` is
merged.**

New file per attempt: `record-v2.json`. The old `record.json` is still written,
unchanged, so nothing existing breaks.

```jsonc
{
  "schema": "agenteval/2",
  "question_id": "bus-stops-cambridge",
  "repeat": 1,
  "calls": [
    {
      "argv": ["count", "-t", "place", "--in", "Cambridge, MA",
               "--where", "categories.primary=bus_stop"],
      "exit_code": 0,
      "stdout_head": "0",
      "stderr_head": "[botmap] Ambiguous --in ...",
      "duration_s": 12.4,

      // the three axes
      "outcome":  "empty",        // ok | empty | error | degenerate
      "blame":    "tool",         // tool | agent | environment
      "recovery": "unguided",     // guided | unguided | n/a

      "class": "C",               // A-F, derived from the three axes
      "subtype": "c-vocabulary",  // only for class C
      "evidence": "bus_stop absent from place taxonomy at all levels; nearest bus_station",
      "probes": [
        {"kind": "vocabulary", "ran": "categories -t place --top 5000 | grep bus_stop",
         "result": "absent", "conclusive": true}
      ]
    }
  ],
  "agent_side": [
    {"kind": "ignored_hint", "at_call": 3,
     "detail": "hint offered bus_station; next 4 calls did not use it"}
  ],
  "tools_used": {"Bash": 5, "Skill": 1, "WebSearch": 2},
  "botmap_calls": 0,
  "answer": {"text": "There are no bus stops in Cambridge.", "verified": null}
}
```

Three things to note:

- **`class` is derived, never stored independently.** It is a function of the
  three axes. If they disagree with the class, the axes win.
- **`probes` records what the scorer did to reach its verdict**, so a
  classification can always be audited. No unexplained labels.
- **`answer.verified`** is `null` for now. Ground truth is a later step; the
  field exists so adding it does not change the schema again.

---

## 4. The taxonomy classifier

### 4.1 The three axes

```
OUTCOME    ok         the call did what the agent needed
           empty      succeeded, returned nothing — MEANING UNKNOWN
           error      refused
           degenerate succeeded, but by an unusable route

BLAME      tool       botmap could have done better
           agent      botmap behaved correctly; the agent misused it
           environment not the tool's fault (network, quota, stale data)

RECOVERY   guided     the tool named a next action
           unguided   the agent was left to guess
           n/a        nothing to recover from
```

### 4.2 The six classes

| Class | Axes | Meaning | Score |
|---|---|---|---|
| **A** Hard failure | `error` + `unguided` | Refused, agent stuck. Raw traceback. | heavy penalty |
| **B** Soft failure | `error` + `guided` | Refused, and said how to fix it. | **near-free** |
| **C** Silent wrong | `empty` + `unguided` | Succeeded, answer wrong, said nothing. | **heaviest** |
| **D** Degenerate | `degenerate` | Right answer, unusable route. | proportional to waste |
| **E** Environment | `blame=environment` | Network, quota, stale release. | **excluded from scoring** |
| **F** Agent-side | `blame=agent` | Tool was fine; agent misused it. | **recorded, not charged to the tool** |

### Web search: record it, do not judge it yet

`hotel-density-two-countries` ran **zero botmap commands** — two web searches, a
citation of official hotel statistics — and **scored 1.00**.

We are **not** building a class or a scoring rule for this yet. We record the
plain fact and decide what it means once we can see how often it happens:

```jsonc
"tools_used":   {"Bash": 5, "Skill": 1, "WebSearch": 2},
"botmap_calls": 0
```

That is all. No `grounded` judgement, no invalidation, no penalty. Both numbers
fall straight out of the transcript we already parse, so it costs nothing.

Why hold off: deciding *why* an agent web-searched needs judgement we do not
have data for. The two plausible reasons point in opposite directions —
searching for **vocabulary** ("what is this category called") suggests the CLI's
own discovery failed, which is a design finding; searching for **the answer**
suggests the attempt is not measuring the CLI at all. We will be able to tell
those apart once we have counts. Guessing now would bake in a rule we cannot
support.

Web search stays allowed regardless. A real agent has it, and removing it would
make the test less like reality.

**Class B is the headline change.** Today a hint is punished twice — counted as
an error, and disqualified from being the recovery that redeems an earlier
error. Under this taxonomy a hint is close to free **and satisfies the recovery
test**. A tool that explains itself is doing its job.

**Class C is the other headline.** Today it is invisible — worse than
mislabelled. A crash is honest; a confident wrong answer is not. C carries the
heaviest penalty of any class.

### 4.3 Class C sub-types

Each has a different fix, so each gets its own name:

| Sub-type | What went wrong |
|---|---|
| `c-vocabulary` | the value does not exist anywhere |
| `c-wrong-column` | the value exists, in a different field |
| `c-wrong-type` | the data lives under a different verb |
| `c-dropped-input` | a flag was silently discarded |
| `c-truncated` | the answer was cut off by a limit |
| `c-wrong-entity` | resolved to the wrong place |
| `c-unknown` | empty, and no probe explained why |

`c-unknown` is deliberate. An honest "we could not determine why this was empty"
is worth more than a guess, and its frequency tells us how good our probes are.

---

## 5. The differential probe

**The idea:** we cannot ask "is this zero correct?" But we can ask **"does this
zero survive a change that should not matter?"** If changing something
irrelevant makes the answer appear, the original was wrong.

Probes run **after** the agent finishes, from the scorer, against the same tool
build. They are never in the agent's transcript — the measurement must stay out
of the thing being measured.

| Probe | Trigger | Action | Concludes |
|---|---|---|---|
| **vocabulary** | any empty with a value filter | is the value in the published taxonomy at all? | `c-vocabulary` |
| **column swap** | empty with `--class`/`--where col=` | retry against `subtype` / `subclass` | `c-wrong-column` |
| **type sweep** | empty with `-t X` | retry the same filter across other types | `c-wrong-type` |
| **limit raise** | any result whose length == the limit | re-run with a much larger limit | `c-truncated` |
| **argv echo** | repeated flags present | did the tool act on all of them? | `c-dropped-input` |
| **entity check** | any `--in` / place qualifier | does the resolved entity match the qualifier's region? | `c-wrong-entity` |

Rules:
- Probes are **cheap CLI calls, no model tokens**. Budget them per question and
  log the count.
- A probe that finds nothing is recorded as inconclusive, not as "fine".
- If no probe fires, the class is `c-unknown` — never silently `ok`.

### Why this is the most valuable part

It answers the real question. When a probe fires, we learn **exactly what the
tool would have needed to say** for the agent to recover unaided:

> `--class recreation` returned 0. The same value as `subtype` returns 86. The
> tool had everything it needed to say *"recreation is a subtype, not a class —
> try `--where subtype=recreation`"* and said nothing.

That sentence is a CLI design requirement, discovered empirically. Collecting
those across 30 questions is the actual output of this experiment.

**Follow-on we expect:** once we see which probes fire most, the fix may be a
`skill.md` instruction ("if a filter returns zero, try it as a subtype before
concluding none exist") rather than a tool change. Both are valid answers to our
question, and the probe data is what tells us which.

---

## 6. Scoring changes

Replace the single error count with class-weighted terms.

```
score = w_correct  * outcome_quality
      + w_recovery * recovery_quality
      + w_effort   * effort
```

- **Class E attempts are dropped, not scored.** Environment failures must never
  reach the optimiser as tool defects.
- **Class F is recorded and reported, not charged.** A tool cannot be optimised
  into fixing agent stubbornness. Counting it would send the proposer hunting a
  fix that does not exist.
- **Class B barely costs anything**, and satisfies the recovery test for a prior
  failure.
- **Class C dominates.** One silent wrong answer should outweigh several honest
  refusals.

Weights are **not fixed here.** Set them once we can see the real class
distribution from a first run — picking them now would repeat the mistake of
weighting a term that cannot move.

### A likely side effect worth watching

The exam is currently saturated: 21 of 30 questions score a perfect 1.00. Many
of those are perfect *only because class C is invisible*. Once C is detected,
those questions should start failing — which **restores headroom without
writing a single new question.**

If that happens, the saturation problem was a symptom of the taxonomy, not of
the question bank. We find out on the first run. Do not rewrite questions until
we have looked.

---

## 7. Feedback changes (`explain.py`)

The README's premise is that the proposer improves by reading *why* something
failed. Today it reads:

```
PROBLEM: 1 failed command(s): bad_category_value.
```

Under the new taxonomy, with probe evidence attached:

```
CLASS C (silent wrong) - c-vocabulary
  The agent ran: count -t place --in "Cambridge, MA" --where categories.primary=bus_stop
  Result: 0 rows, exit 0, nothing on stderr.
  Probe: `bus_stop` does not appear in the place taxonomy at any level.
         Nearest real value: `bus_station` (L3, travel).
  The tool had the information needed to say this and did not.
```

That is a fix instruction, not an error code. It names the mechanism, the
evidence, and the missing behaviour.

---

## 8. Sabotage validation

We are building a detector for failures that are invisible by definition. We
therefore cannot trust it until we watch it fire.

`sabotage.py` holds fixtures with known answers — at minimum one per class and
one per class-C sub-type — and asserts the classifier produces the expected
verdict. **A silent-wrong fixture that classifies as clean is a build failure.**

This is not optional polish. The one thing we know about silent failures is that
test suites do not catch them: in the production study, ~0% were caught by 4,286
unit tests during the silent phase, while ~70% were caught by a human reading
output. Sabotage fixtures are how we avoid being in that 0%.

---

## 9. What each arm does

**Nobody starts until `contract.py` is merged.** It is the interface all three
build against.

### Arm B — the contract and the probe
1. `contract.py` — record-v2 schema, writer, validator. **Blocking. Do this first
   and tell me the moment it lands.**
2. `probe.py` — all six probes, with a per-question call budget and inconclusive
   handling.
3. Wire record-v2 alongside the existing record. Old path keeps working.

### Arm C — the classifier and the scorer
1. `taxonomy.py` — three-axis classifier, class derivation, C sub-types.
   Its existing `network_failure` work moves here as class E; `quota_exhausted`
   gets built (it was designed and never committed).
2. `score.py` — class-weighted scoring, E dropped, F recorded-not-charged.
   **Leave weights as named constants with a TODO. Do not tune them yet.**
3. Prove the class-B fix with arm A's `count-zero-hint` candidate: under the new
   scorer it must score **better** than baseline, not worse.

### Arm A — evidence, explanation and sabotage
1. `sabotage.py` — fixtures per class and per C sub-type, from real recorded
   traces. It has the deepest trace knowledge and `failure_dataset.yaml` already
   maps 26 questions to the defects they hit.
2. `explain.py` — the feedback text above.
3. Agent-side (class F) detection: hint offered at call N, not used by N+1.

### Me
Sequencing, cross-arm contract questions, and keeping the arms from messaging
each other. No decisions taken unilaterally.

### All arms — the standing instruction

Every time a probe fires or a class is assigned, ask: **what property would the
CLI have needed for this not to happen?** Write it into
`docs/agent-friendly-cli.md` in the four-field shape from section 0.1.

That file is the deliverable. Your component is how we generate evidence for it,
not the point in itself. A run that produces one well-evidenced design property
is worth more than a run that moves a score.

---

## 10. Sequence

```
1.  contract.py                        Arm B     <- everything blocks on this
2.  taxonomy + probe + sabotage        B, C, A   in parallel, same contract
3.  sabotage passes                    all       gate: no run until fixtures fire
4.  one instrumented run, no optimiser all       just to see the class distribution
5.  read the distribution together     us        decide weights, and whether the
                                                 exam still needs new questions
6.  paired before/after experiments   all       one per candidate property:
                                                 change it, re-run, compare traces
```

Step 4 is a measurement run, not an optimisation run. Its output is two things:

1. a histogram of failure classes — the first genuinely new information this
   project will have produced; and
2. the BEFORE traces for every candidate property.

Step 6 is where the answer actually gets made. Each candidate property gets one
paired experiment: apply the change, re-run the same questions under the same
conditions, and compare traces. Commands burned, turns taken, whether the agent
recovered unaided, whether it reached the right answer.

**Arm A's three existing candidates are already Tier-2 experiments waiting to
run.** `count-zero-hint` is precisely "add the near-match hint" — its paired run
confirms or refutes property 2. `skill-bus-station` is an instruction-lever fix
for property 1. They were built to move a score; they are more valuable as
controlled before/after experiments, and that is how we should run them.

---

## 11. Deliberately not doing

- **Not editing `botmap/evals/`.** Not ours, not the point.
- **Not re-scoring old runs.** They stay as history.
- **Not tuning weights yet.** Not until we can see a real class distribution.
- **Not writing new exam questions yet.** Detecting class C may restore the
  headroom on its own. Look first.
- **Not resuming any optimiser run** until steps 1-5 are done.

---

## 12. Implementation steps

Ordered. Each step names its deliverable and how we know it is done. Nothing
starts until the step above it is finished, except where marked parallel.

### Phase 0 — skill isolation  *(blocking, one flag)*

**Scope decision (2026-08-21): `--setting-sources project` only.**
The other two candidates are deliberately NOT in phase 0 — see below.

**0a. Isolate skills.** Add `--setting-sources project` to the `claude -p`
invocation in `runner.py`.

*Why:* measured 2026-08-21 — without it the agent under test sees 30+ of the
operator's personal skills (`herdr`, `context-lens`, `lavish`,
`mattpocock-skills:*`, `find-skills`). That is an artifact of one machine: nobody
else could reproduce our numbers, and neither could we after changing our own
setup. With the flag: 13 skills, `botmap` plus Claude Code built-ins.

*Done when:* a probe run lists `botmap` and built-ins only, and a normal
question still completes.

*Owner: Arm B. Two cheap probe calls, no other spend.*

---

#### Deliberately not in phase 0

**Tool restriction — NOT changed.** `--allowedTools Bash` does not actually
restrict; a recorded attempt invoked `Skill`, `Bash`×5, `ToolSearch` and
`WebSearch`. We are leaving this alone because **a real agent has those tools
too.** Removing them would make the harness less like real use, not more.

But it has a consequence we must not lose: when an agent answers partly by web
search, "it succeeded" no longer cleanly means "the CLI was drivable". So the
open suggestion is to **record the bypass rather than block it** — a per-attempt
flag for "the agent reached outside botmap, and at which call". That is an
observation, not a restriction, and it is arguably its own signal about CLI
usability: a CLI an agent routes around is telling us something.

*Not decided. Raise at phase 5 with real numbers.*

**Invocation recording — not in phase 0.** Logging the flags, model, setting
sources and resolved tool list into the run summary. Cheap and non-behavioural,
but out of scope for phase 0 by the same decision. Worth folding into
`contract.py` in phase 1 if it lands naturally there.

### Phase 1 — the contract  *(blocking)*

**1a. `agenteval/contract.py`.**

```python
@dataclass(frozen=True)
class Probe:        kind: str; ran: str; result: str; conclusive: bool
@dataclass(frozen=True)
class CallVerdict:  outcome: str; blame: str; recovery: str
                    cls: str; subtype: str | None
                    evidence: str; probes: tuple[Probe, ...]
@dataclass(frozen=True)
class Record2:      schema: str; question_id: str; repeat: int
                    calls: tuple[...]; agent_side: tuple[...]; answer: dict

def derive_class(outcome, blame, recovery) -> str   # the ONLY place class is computed
def write(path, record) -> None
def load(path) -> Record2
def validate(raw: dict) -> list[str]                # returns problems, never raises
```

*Done when:* round-trips a hand-written record, `validate` rejects a record whose
stored `class` disagrees with its axes, and Arms A and C can both import it.

*Owner: Arm B. Announce the moment it lands — two arms are blocked on it.*

### Phase 2 — three components, parallel, same contract

**2a. `agenteval/taxonomy.py`** — *Arm C*
- `classify(call, probes) -> CallVerdict`
- the three axes; class derived only via `contract.derive_class`
- class E absorbs its existing `network_failure`; build `quota_exhausted`
  (designed, never committed)
- *Acceptance:* a `did you mean:` call classifies **B**, scores better than
  baseline, and satisfies the recovery test. Arm A's `count-zero-hint` is the
  fixture.

**2b. `agenteval/probe.py`** — *Arm B*
- `probe_empty(call, tree) -> list[Probe]` — the six probes from section 5
- per-question call budget, logged; inconclusive recorded as inconclusive
- probes run from the scorer, **after** the agent finishes, never in its
  transcript
- *Acceptance:* on the recorded `--class recreation` case it returns
  `c-wrong-column` with the 0-vs-86 evidence attached.

**2c. `agenteval/sabotage.py` + `explain.py`** — *Arm A*
- fixtures: one per class, one per class-C subtype, drawn from real recorded
  traces (`failure_dataset.yaml` already maps 26 questions to their defects)
- `explain(record) -> str` — the fix-instruction feedback from section 7
- agent-side (class F) detection: hint offered at call N, unused by N+1
- *Acceptance:* every fixture produces its expected verdict; a silent-wrong
  fixture classifying as clean is a build failure.

### Phase 3 — the gate

**3a.** Sabotage suite passes. **No run of any kind until it does.**
We are building a detector for failures that are invisible by definition; the
one thing known about them is that test suites miss them.

**3b.** Run the classifier over the 60 **already-retained** attempts from
`baseline-noise-run1-3009509`. Costs nothing — no model calls — and gives the
first real class distribution before we spend anything.

### Phase 4 — one instrumented measurement run

**4a.** 30 questions × 2 repeats, new evaluator, **no optimiser**.
*Output:* the class histogram, and a BEFORE trace for every candidate property.
*Explicitly not:* a score to compare against anything.

**4b.** Check the saturation prediction: do questions that scored 1.00 under the
old scorer now fail? If yes, the exam was never the problem — the taxonomy was.

### Phase 5 — read it together

Weights get set here, from the observed distribution, not before. Also decided
here: whether the question bank needs new questions after all.

### Phase 6 — paired before/after experiments

One per candidate property: apply the change, re-run the same questions under
the same conditions, compare traces. Arm A's three candidates are the first
three, already built.

Each produces a `docs/agent-friendly-cli.md` entry with BEFORE, CHANGE, AFTER
and VERDICT — confirmed or refuted.

### What is NOT in these steps

- No optimiser run. GEPA stays off until phase 6 at the earliest.
- No weight tuning before phase 5.
- No new exam questions before 4b says we need them.
- No edits to `botmap/evals/`.
