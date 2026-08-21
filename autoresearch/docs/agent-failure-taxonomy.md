# Agent failure taxonomy — research and proposal

Status: **draft for discussion.** Nothing here is implemented. Written 2026-08-21
while all three arms are paused.

---

## 1. The problem, stated precisely

We currently score every CLI call with one label. That label answers one
question — *did stderr look like an error?* — and we then treat it as if it
answered a different question: *did this go well?*

Those are not the same question, and today we get **both directions wrong**:

**We punish the tool for being helpful.** When `count` finds nothing and says
*"did you mean: bus_station?"*, `taxonomy.py` labels it `bad_category_value`.
So the call counts as an error. Worse, `score.py:75` requires
`classify_error(c) is None` for a call to count as a *recovery* — so the helpful
message also destroys the agent's ability to demonstrate it recovered. A hint is
penalised twice, and it is penalised precisely because it did its job.

**We reward the tool for being silent.** Ask for a category that has never
existed and `count` prints `0`, exits 0, and writes nothing useful to stderr.
`classify_error` returns `None` — a clean call. The agent reports "there are
none", which is wrong, and the run scores 1.00.

> A zero row count is not a clean answer. It is an **unverified** answer. It can
> mean "there are genuinely none" or "you asked the wrong question and I won't
> tell you which."

Everything below follows from separating those two meanings.

---

## 2. What our own data says

`proposals.json` holds 20 defects found by earlier probing. **Nine of them
produce the same observable: a result that looks fine and is wrong.** They are
mechanically different from each other, and each needs a different fix — but
today they are indistinguishable to the scorer, because all nine exit 0 with
quiet stderr.

| # | Mechanism | Measured example |
|---|---|---|
| 2 | **Vocabulary miss** — the value never existed | `--category bus_stop` → 0. Real slug is `bus_station` |
| 14 | **Wrong column** — value exists, in another field | `--class recreation` → 0; as `subtype` → 86 |
| 12 | **Wrong type** — data lives under another verb | `landuse --class beach` → 0; Malta has 67 under `land` |
| 17 | **Dropped input** — flag silently discarded | `--class trunk --class primary` → trunk dropped, no warning |
| 16 | **Truncated output** — the answer was cut off | `--top 200` omits `bus_station`; `--top 5000` has all 963 |
| 15 | **Wrong entity resolved** | `where "Malta, MT"` → Malta, **Montana**. Zero bytes on stderr |
| 3 | **Hint exists but not on this verb** | Fires on `places`, not on `count`/`sample` — where the docs tell agents to start |
| 13 | **Blocked, then redirected to an empty query** | Guard refuses a working query, recommends one that returns nothing |
| 20 | **Recovery advice that hangs** | `no_match` recommends a command that takes 10 minutes and prints nothing |

Two more that are not "wrong answers" but are still invisible:

| # | Mechanism | Measured example |
|---|---|---|
| 1 | **Degenerate success** — right answer, unusable cost | `where "Monaco" --geometry` → correct, after **19m42s** of total silence |
| 11 | **Discovery impossible** — no way to ask the question | No `categories --search`; you must guess `--top N` and grep |

**This is the whole argument for a richer taxonomy.** Nine distinct causes,
nine distinct fixes, one indistinguishable observable. An optimiser cannot
propose a targeted fix when every failure looks identical.

---

## 3. What the research says

Four sources worth knowing about. The most useful finding is that our situation
is a named, studied phenomenon — not a quirk of our setup.

### 3.1 Silent failures in production agent runtimes

The closest match to our problem. It defines silent failure as *"error signal
exists somewhere; never reaches a human in actionable form"* and gives five
classes. Two are directly ours:

- **Class C — Error swallowing & dilution.** The error happens but loses its
  cause as it crosses layers. Our `--class trunk --class primary` is exactly
  this: Click drops a value and nothing downstream knows.
- **Class D — Fail-plausible (chained hallucination).** The error is
  *transformed* into confident false output. Their phrase for it is
  **"counterfeit health"**. This is our `bus_stop` case precisely: tool returns
  0, agent synthesises "there are no bus stops in Cambridge", and the system
  delivers a confident wrong answer on schedule.

Their detection result should worry us, because we are making the same bet they
made and lost:

- **~0%** of silent failures were caught by their 4,286 unit tests and 827
  governance checks *during the silent phase*
- **~70%** were caught by a human reading the actual output

That is our position exactly. Our exam is the automated check that sees nothing;
the defects were found by people probing by hand.

They also recommend **sabotage validation** — deliberately inject a violation
and confirm the guard fires. That caught 67 checks that were executing empty
strings and passing. We should adopt this: it is the direct answer to "how do
we know our new taxonomy actually detects anything?"

### 3.2 MAST — multi-agent system taxonomy

Four top-level classes — Planning, Execution, Coordination, Communication —
with 23 patterns beneath. Coordination and Communication do not apply to us
(single agent, single tool). The useful idea is the **two-level structure**: a
small number of stable top-level classes, with fine-grained patterns underneath
that can grow without breaking anything that consumes the top level.

### 3.3 Tool-augmented LLM failure taxonomy (UW)

Separates **tool-side faults** from **agent-side faults**. We need this
distinction badly and do not have it: today, an agent that guesses a bad
category and a tool that hides a real category produce the same label. Only one
of those is botmap's fault, and only one is fixable by editing botmap.

### 3.4 Practitioner failure-mode lists

Consistently name three that we do not currently capture:

- **empty-result mishandling** — the agent proceeds as if empty means zero
- **tool misuse** — misreading tool output
- **retrieval miss** — the information was there and was not found

---

## 4. Proposed taxonomy

The central change: **stop asking one question, ask three.** Every call gets
three independent facts, not one label.

```
1. OUTCOME     did the call do what the agent needed?       ok | empty | error | degenerate
2. BLAME       whose fault is it?                           tool | agent | environment
3. RECOVERY    did the tool leave the agent able to fix it? guided | unguided | n/a
```

The current single label conflates all three, which is why it cannot separate
"helpful refusal" from "silent wrong answer".

### 4.1 Why three axes rather than more labels

A hint and a silent zero differ on **recovery**, not on outcome — both returned
nothing. A bad category the agent invented and a real category the tool hides
differ on **blame**, not on outcome. Flattening these into one list means every
new distinction multiplies the label count and breaks `synthesize.py`'s
clustering. Three small axes stay stable as we learn more.

### 4.2 The classes

**A. Hard failure** — tool refused, agent left stuck.
`outcome=error, recovery=unguided`. Raw traceback, unclassified error.
*Score: heavy penalty.* This is a real tool defect.

**B. Soft failure** — tool refused, and said how to fix it.
`outcome=error, recovery=guided`. `did you mean:`, usage listing valid options,
`no such command` with the command list.
*Score: light penalty, and it MUST satisfy the recovery test.* The tool did its
job. The round trip cost something, so it is not free — but it is close to it.

**C. Silent wrong** — tool succeeded, answer is wrong, nothing said. ← *the one
that matters*
`outcome=empty, recovery=unguided`. Sub-typed by mechanism, because each
mechanism has a different fix:

| Sub-type | What happened | Detectable from |
|---|---|---|
| `c-vocabulary` | value doesn't exist anywhere | cross-check value against the published taxonomy |
| `c-wrong-column` | value exists in a different field | retry the value against `subtype`/`subclass` |
| `c-wrong-type` | data lives under a different verb | retry across types |
| `c-dropped-input` | a flag was silently discarded | compare argv against what the tool reports acting on |
| `c-truncated` | the answer was cut off by `--top` | result length equals the limit exactly |
| `c-wrong-entity` | resolved to the wrong place | resolved name/country vs. the qualifier asked for |

*Score: heaviest penalty of all.* Worse than a crash, because a crash is honest.

**D. Degenerate success** — right answer, unusable route.
`outcome=degenerate`. 20-minute silent call; bulk `download` when a verb
existed; ten commands to answer a one-command question.
*Score: penalty proportional to waste.*

**E. Environment** — not the tool's fault at all.
`blame=environment`. Network failure, quota exhaustion, stale data release.
*Score: excluded entirely — attempt dropped, not scored.* Arm C already built
`network_failure`; `quota_exhausted` was designed and never committed.

**F. Agent-side** — the tool behaved correctly, the agent misused it.
`blame=agent`. Ignoring a hint that was given; not reading its own error;
repeating an identical failing command.
*Score: this is signal about the exam, not the tool.* Worth recording
separately — a tool cannot be optimised into fixing an agent's stubbornness,
and counting it as a tool defect would send the optimiser hunting for a fix
that does not exist.

---

## 5. How each is detected

The honest constraint: **class C mostly cannot be detected from stderr.** That
is why it is invisible today. It needs one of three things:

1. **Ground truth per question** — the expected answer or its shape. This is
   Arm A's paused fix #1, and `TODO.md` has called it the highest-value
   improvement available for months.
2. **A differential probe** — re-run the same query with one thing changed
   (`class` → `subtype`, `landuse` → `land`, `--top 200` → `--top 5000`). If
   the answer changes, the original was wrong. This is cheap, mechanical, and
   needs no ground truth. It directly detects `c-wrong-column`,
   `c-wrong-type` and `c-truncated`.
3. **A vocabulary cross-check** — does the value the agent used appear in the
   published taxonomy at all? Detects `c-vocabulary` with no extra queries.

Option 2 is the interesting one, because it turns an unanswerable question
("is this zero correct?") into an answerable one ("does this zero survive a
change that should not matter?").

---

## 6. How this plugs into the loop

**Scoring.** Each class gets its own weight rather than everything collapsing
into one error count. Class C dominates, B is near-free, E is excluded, F is
recorded but not charged to the tool.

**Feedback — the part that actually matters.** The README's premise is that
GEPA improves by reading *why* something failed. Today the feedback says
"1 failed command: bad_category_value". Under this taxonomy it can say:

> The agent ran `count --where categories.primary=bus_stop` and got 0 rows with
> no explanation. `bus_stop` does not appear in the place taxonomy at any level.
> The nearest real value is `bus_station`. The tool had the information needed
> to say so and did not.

That is a fix instruction, not an error code. It names the mechanism, the
evidence, and the missing behaviour.

**Compatibility warning.** `synthesize.py` reads the label out of
`record.json` as a bare string and never imports the taxonomy module. So
renaming or adding labels **silently changes report clustering** — no import
error, no failing test. Any change here needs the report checked by hand once.

**Two taxonomies, two contracts.** botmap's `classify_error` returns `None` for
clean; autoresearch's `classify` returns `"clean"` and never `None`, on
purpose. A fix written for one will not port to the other.

---

## 7. Open questions — to decide

1. **Three axes, or one richer label list?** Three axes are cleaner and stay
   stable, but they change the `record.json` shape and every consumer.

2. **Do we build the differential probe?** It is the only way to catch class C
   without ground truth, and it costs extra CLI calls per question (cheap, no
   model tokens). Or do we wait for ground truth and skip it?

3. **Is agent-side failure (class F) in scope at all?** It is real signal, but
   we cannot fix it by editing botmap. Record it, or ignore it?

4. **Which exam do we fix first** — botmap's `evals/`, autoresearch's, or a
   shared module both import? A shared module removes the drift permanently but
   is a bigger change.

5. **Do we adopt sabotage validation?** Deliberately feed the scorer a known
   silent-wrong case and assert it fires. Cheap, and it is the only way to know
   the new taxonomy detects anything at all.

6. **What happens to the existing runs?** Every recorded score used the old
   labels. Re-score from retained attempts, or treat the old numbers as
   unusable and start clean?

---

## Sources

- [When Errors Become Narratives: A Longitudinal Taxonomy of Silent Failures in a Production LLM Agent Runtime](https://arxiv.org/html/2606.14589)
- [Aegis: Taxonomy and Optimizations for Overcoming Agent-Environment Failures in LLM Agents](https://arxiv.org/pdf/2508.19504)
- [A Taxonomy of Failures in Tool-Augmented LLMs](https://homes.cs.washington.edu/~rjust/publ/tallm_testing_ast_2025.pdf)
- [AgentAtlas: Beyond Outcome Leaderboards for LLM Agents](https://arxiv.org/pdf/2605.20530)
- [XAI for Coding Agent Failures: Transforming Raw Execution Traces into Actionable Insights](https://arxiv.org/pdf/2603.05941)
- [Detecting AI Agent Failure Modes in Production](https://latitude.so/blog/ai-agent-failure-detection-guide)
- [7 AI Agent Failure Modes and How to Prevent Them](https://galileo.ai/blog/agent-failure-modes-guide)
