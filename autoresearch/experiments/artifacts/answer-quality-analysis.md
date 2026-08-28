# Agent-usability eval — run report

**Bank:** `evals/questions-newset.yaml` (30 questions, tiers 1–5)
**Runs:** 60 (2 repeats × 30), `claude -p`, model `sonnet`, 6 parallel shards
**Release:** Overture `2026-07-22.0`, botmap `0.1.2`
**Cost:** $21.42 · ~35 min wall-clock · 309 CLI calls
**Artifacts:** `evals/runs/<id>__r<n>/{transcript.jsonl,shim.log,record.json}`

Every claim below is quoted from a captured trace. Answer quality was graded by
reading all 60 transcripts against each question's `notes`; the automated
scorer does not measure it (see §2).

---

## 1. The thesis holds: agents use the verbs

The redesign's central bet — question-shaped verbs beat `download --bbox` — is
confirmed. Across 309 calls:

| verb | calls | | verb | calls |
|---|---|---|---|---|
| `count` | 88 | | `sample` | 10 |
| `where` | 66 | | `capabilities` | 9 |
| `categories` | 32 | | `download` | **8** |
| `roads` | 26 | | `addresses` | 8 |
| `places` | 21 | | `buildings` | 7 |
| `at` | 16 | | `water` | 2 |
| `schema` | 15 | | `building_part` (invalid) | 1 |

**`download` is 2.6% of all calls**, and *zero* runs downloaded a type that has
a convenience verb. Trace G (reflexive `download` fallback) is effectively
dead. `count`-before-pulling is now the dominant habit — 88 calls, the most of
any verb.

Discovery verbs are also being used unprompted: `categories` 32, `schema` 15,
`capabilities` 9. Agents self-serve the vocabulary instead of guessing.

All 17 runs that hit a CLI error recovered.

---

## 2. The scoring is measuring the wrong thing

**`completed: 60/60` is not true.** `trace.py:123` defines it as:

```python
completed = (not is_error) and bool(final_answer)
```

Any non-empty string counts. So *"I'll report back once it finishes"* scores
identically to a correct answer.

**Nine runs delivered nothing and all nine scored as clean passes.** The worst
case is instructive:

> `which-admin-areas__r1` — **zero** CLI calls, zero errors, zero wasted
> commands, `completed: true`, `run_status: "ok"`. A perfect record.
> Final answer: *"I've kicked off the reverse-geocode lookup… I'll report back
> once it finishes."* The user got nothing.

Three further metric defects:

- **Low command count is rewarded, and the cheapest way to achieve it is not to
  use the tool.** `motorways-rhode-island__r2` is tier 1's best run on every
  process metric — 0 commands, 0 errors, 10 s, cheapest — because it answered
  entirely from memory.
- **`unnecessary_download` is derived from the question, not the type**
  (`score.py:69,94`). Both flagged "unnecessary" downloads are `-t division`,
  which has no bulk-enumeration verb — so they were legitimate and mislabelled.
- **No axis checks whether the answer came from the CLI.** This is the single
  biggest gap; see §3.

**Recommended:** add `answered: bool` (distinguish an answer from a deferral),
derive download legitimacy from the *type*, and add a grounding check — did the
headline number appear in any command's stdout?

---

## 3. Top failure cluster: agents run the right command, then discard the answer

This is the most important result in the run, and it is invisible to every
current metric.

`hospitals-rhode-island__r1` constructed the ideal command, then:

> "The raw map count came back as **169**, but that number is unreliable…
> roughly **13–14**… This lines up with Rhode Island's commonly cited total of
> ~13 licensed hospitals."

`r2` cited the RI Department of Health. Its only listing command was a `head
-40` window of a reverse-sorted name histogram containing **none** of the
hospitals it went on to name.

Quieter variants:

- `bbox-cambridge__r2` quotes the correct bbox (≈17.6 sq mi), then reports
  "about 6.4 sq mi" — the real city land area, recalled from memory,
  contradicting the number it just printed.
- `nearest-pois-harvard__r2` claims its list is "sorted by distance" after
  silently reordering `at`'s already-sorted output.

**4 of 10 tier-1 runs delivered answers not derived from the CLI**, all with
`run_status: "ok"`.

### The skill did not trigger at all for colloquial phrasing

`tattoo-category-discovery` — **both** runs, zero CLI calls, one turn each:

> r2: *"This is outside coding/programming work, so I can't use tools for it"* —
> then named **Fat Ram's Pumpkin Tattoo** and **Redemption Tattoo** from memory.
> r1: told the user to search Yelp.

Every other tier-2 prompt ("How many…", "Show me…", "Find every…") triggered
the skill. *"Where can I get a tattoo"* did not. The skill description covers
"places… even if they don't use geo terms", but the trigger is keyed to
analytical phrasing, not intent. This is the exact hallucination the CLI exists
to prevent, and the CLI was never invoked.

---

## 4. Second cluster: silent long-running commands cause abandonment

Nine runs across tiers 2–5 ended on a promise instead of an answer. The
sequence is identical every time: a command exceeds the 120 s tool timeout →
the harness backgrounds it → the agent cannot wait → it burns turns on
`ScheduleWakeup`/`Monitor`/`until`-loops → the turn ends.

Implicated verbs: `where --geometry` (~20 min), `containing` (~10 min), and
long multi-download bash chains.

The costliest instance is `building-parts-detail__r1`, which **computed the
answer and then withheld it**: its log contains 200 matched buildings by name
(Stata Center, Simmons Hall, Baker House), after which it chose an optional
polygon clip, hit the `where --geometry` hang, and ended the turn. Meanwhile
`r2` skipped the join entirely — took the `has_parts=true` shortcut the bank
flags as answering a different question — and shipped the most polished answer
in the set. **The run that did the work scored a non-answer; the run that
skipped it scored a clean one.** At 202 vs 200, no reader could tell.

This is both an agent failure and a CLI failure, but the CLI's is primary and
far cheaper to fix: these verbs emit **nothing** for ten to twenty minutes — no
progress line, no ETA. An agent cannot distinguish slow from hung. A single
stderr progress line would convert most of these failures into passes without
touching the model.

The agent-side fault is real too: `which-admin-areas` had a documented
seconds-long fallback (`at LAT,LON -t place -n 1`) that neither run reached
for, and no run time-boxed its wait as the bank's notes anticipated.

---

## 5. New CLI defects surfaced by the run

All verified directly after the graders flagged them. These are additions to
`findings.md`.

### 5.1 Silent wrong-place resolution — the trace-B fix has a hole

```
$ botmap --json where "Malta, MT"
  resolved: Malta | locality | US/US-MT | bbox=[-107.89, 48.34, -107.86, 48.36]
  stderr: (0 bytes)
```

Malta, **Montana**. Zero bytes on stderr — no ambiguity warning, because from
the resolver's point of view this is not ambiguous, it is simply a different
valid place. The warning added for trace B (Alameda→Saskatchewan) only fires
when *multiple* candidates match; it cannot fire here.

Both `beach-accessibility-malta` runs hit it. Worse, **both
`clipping-polygon-qgis` runs backgrounded `where "Malta, MT" --geometry`** — so
the polygon they waited 20 minutes for was probably Montana. The latency hid a
wrong answer.

`where "Reykjavik, IS"` similarly resolves to `Is (locality, ES-AS, pop 2)` in
Spain; `waterfront-buildings-reykjavik__r2` ran a full building count against
Spain before noticing.

### 5.2 `categories --top N` truncates silently

| `--top` | rows returned | `bus_station` present? |
|---|---|---|
| 200 | 200 | **NO** |
| 500 | 500 | YES |
| 5000 | 963 (all) | YES |

No "showing 200 of 963" indicator. Both `bus-stops-cambridge` runs found the
right category only by *guessing* a larger N. `asian-restaurants-rollup__r2`
saw no `vietnamese_restaurant` in its `--top 300` and told the user *"No
Vietnamese… categories showed up in Cambridge's data"* — it exists at count 6.
`basic-category-rollup__r1` turned a truncated `--top 100` grep into a
confident false schema claim: *"no separate 'drug store' category exists in the
schema"*.

Any workflow that greps the category list inherits this failure mode.

### 5.3 `--class` silently keeps only the last value, and the comma form silently returns nothing

```
roads --in Malta --class trunk                  -> 1247
roads --in Malta --class primary                -> 1341
roads --in Malta --class trunk --class primary  -> 1341   # trunk dropped
roads --in Malta --class "trunk,primary"        -> exit 0, 0 rows
```

`--class` is single-valued, so Click keeps the last. Both forms exit 0. Both
`junction-density` runs and `malta-highways-absent-class__r1` hit this; they
recovered only because they independently cross-checked `wc -l` against a
`count`. A less careful agent ships the wrong number with a clean exit code.

### 5.4 Assorted, all confirmed

- `where` rejects `-o` (`Error: No such option: '-o'`) with no suggestion,
  forcing shell redirection — which is what backgrounded the hanging
  `--geometry` calls in the first place.
- `sample --json` → `Error: No such option '--json'. Did you mean '--in'?` The
  suggestion is actively misleading; `--json` is a global flag that must
  precede the subcommand.
- `count` rejects `--street` while `addresses` accepts it — cost
  `street-canonical-form__r1` a turn.
- `--where addresses.country=X` → `Field 'addresses.country' is invalid:
  addresses is not a struct`. A good error; the agent correctly worked around
  it by downloading and filtering in code.

### 5.5 One error message worth copying

The `categories -t building` guard is the template the rest should follow:

> "`categories` enumerates `categories.primary` for place features. For
> `building`, the classifying field is `class` — run `botmap --json schema -t
> building`… or filter directly with `botmap buildings --class <value>`."

Both `residential-share-cambridge` runs hit it and neither lost a step.

---

## 6. How the bank's predicted traps performed

| trap | outcome |
|---|---|
| `at --category` (Skill recipe 7) | **Fired 3×** — `Error: No such option: --category`. All recovered via `at --help`. Pure friction from a wrong doc example. |
| Reykjavík diacritic | **Fired 4×**. Both runs recovered on world knowledge, not on the error text — the `no_match` message's three suggestions omit the one that works. |
| `Monaco, MC` qualifier | **Fired 2×**, both recovered in ~1 s. 100% reproducible; better fixed in the parser than the message. |
| `bus_stop` → `bus_station` | **Discriminating.** Both runs diagnosed the gap; only `r2` converted the diagnosis into an answer. `r1` punted. |
| `street` uppercase / `--where` exact | **Fired once**, recovered explicitly: *"The street name is stored in uppercase… which is why the exact --where match failed."* |
| `sample` is not a sample | **Avoided by both runs** — both used two `count` calls. |
| `asian_restaurant` interior node | **Main trap avoided** by both; both then hit the *sub*-trap, folding `pan_asian_restaurant` and `asian_fusion_restaurant` (which sit under `international_fusion_restaurant`) into the Asian subtotal. Their 228 and 218 bracket the ~224 reference by offsetting errors, not by correct method. |
| `basic_category` | **Never discovered** by either run. Both answered from the `pharmacy` leaf. |
| Brooklyn 460k refusal | Both counted first — correct — but both then downloaded anyway without confirming. Neither mentioned GeoParquet. |
| `has_parts=true` shortcut | **Taken**, exactly as predicted, and indistinguishable from the real join in the output. |

---

## 7. Run-to-run divergence exceeds the pass/fail signal

Four questions produced materially different answers across identical repeats:

| question | r1 | r2 | driver |
|---|---|---|---|
| waterfront-buildings-reykjavik | 2,388 | 144 | hand-drawn bbox vs the CLI's 2 km downtown locality box (**16×**) |
| junction-density | Meeker Ave | The Southside | each run explicitly demotes the other's winner |
| hotel-density-two-countries | 3× | 2.4× | r1 filtered cross-border spill (212 hotels), r2 shipped the raw 352 |
| bike-parking-coverage | "concentrated" | "only moderately" | identical 124 m median, different baseline |

The dominant cause is that **`--in` yields a bbox, not a polygon, and its
quality varies wildly by place.** Reykjavík's locality box is a ~2 × 2 km
downtown rectangle; Cambridge's is ~2.5× the city's land area. Whether an agent
trusts or overrides it moves answers by an order of magnitude — and nothing in
the output signals which situation you are in.

---

## 8. Recommendations, ranked

1. **Emit a progress line on stderr from the division-geometry paths**
   (`where --geometry`, `containing`, `boundary`). Highest value per line of
   code in this report: it converts most of the nine abandonment failures into
   passes without touching the model.
2. **Fix the scorer** — add `answered` vs `deferred`, derive download
   legitimacy from the type, add a grounding check that the headline number
   appears in some command's stdout. Until then every aggregate is inflated.
3. **Warn on single-candidate cross-region resolution.** `Malta, MT` →
   Montana silently is a correctness bug that latency can hide entirely.
4. **Make `categories --top` state what it truncated** (`showing 200 of 963`),
   or add `--search`. It manufactures false negatives today.
5. **Make `--class` repeatable, or reject the comma form loudly.** Both current
   behaviours exit 0 with wrong data.
6. **Fix the Skill's non-running examples** — `at --category` (3 wasted calls
   this run), `where … --json`, `sample --limit`, `--category bus_stop`.
7. **Widen the skill trigger to colloquial phrasing.** "Where can I get a
   tattoo" must route to botmap; today it produces hallucinated shop names.
8. **Reconsider `--in` returning a bare bbox.** It is the largest single source
   of answer divergence in the run.
