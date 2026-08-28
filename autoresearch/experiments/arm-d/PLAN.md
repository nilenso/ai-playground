# Arm D plan memo — next experimental wave

Status: **READY plan only**. Do not run paid experiments yet. Keep `botmap/evals/` untouched. Any botmap edits should live only in isolated clones/worktrees; evaluator files are read-only during tool-candidate work unless an experiment below explicitly says evaluator/probe work is required first.

## Priority order

1. **Wrong-type hint** — highest ready-to-run information gain per dollar: small bucket (3), precise probe evidence, direct sibling of the confirmed wrong-column property.
2. **A→B recovery** — large remaining penalty (A=38), but needs triage because A mixes real raw errors, unsupported option placement, and possibly guided errors misclassified as A.
3. **Instruction-vs-tool lever comparison** — cheap and scientifically important; best after one more tool-side property so the comparison is not based only on truncation.
4. **Full-bank replication of confirmed hints** — high confidence / higher cost; validates generality after at least one more small experiment.
5. **Discovery command** — potentially broad benefit, but confounded with truncation and zero diagnostics; use after probe improvements or after full-bank confirmed-hint replication.
6. **Zero-result diagnostics** — big bucket (`c-unknown`=25), but not fair until probes split true empty vs vocabulary/canonicalization vs unsupported column.
7. **Entity resolution echo** — current BEFORE has no valid `c-wrong-entity`; requires a deliberate ambiguous-location mini-bank and probe validation.
8. **Progress/estimate** — only D=3 and tied to long route/data-size behavior; likely expensive/confounded.

## Common comparison baseline

Use unchanged-botmap BEFORE source:

```text
experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
```

Histogram after MA/MT probe repair:

```json
{"records":60,"class_counts":{"clean":389,"C":55,"B":15,"A":38,"D":3},"subtype_counts":{"c-truncated":25,"c-unknown":25,"c-wrong-type":3,"c-wrong-column":2}}
```

For each paired run, compare matched question IDs and repeats against this source; do not rescore old records in place.

## Worktree / clone strategy

- Use one botmap clone per candidate, named by lever and property, e.g. `/Users/priyangapkini/workspace/ar-d/botmap-wrong-type-hint`.
- Branch names: `arm-d/<property>-<lever>`.
- Do not edit `botmap/evals/`.
- For tool-side candidates, edit botmap only. Treat `autoresearch/agenteval/*` as read-only unless the experiment is explicitly in the “needs evaluator/probe work first” section.
- For prompt-side candidates, use a project skill/instruction candidate, not botmap code. Keep it in a separate experiment branch/worktree so tool and prompt levers are not complected.
- Run directory names: `experiments/runs/after-<property>-<lever>-<shortsha-or-instructionid>/`.
- Paired result memos: `experiments/paired/<property>-<lever>/result.md`.

## Experiments ready to run now

### 1. Wrong-type hint experiment — recommended first

- **Hypothesis / principle:** If the same filter has rows under another feature type, an agent-friendly CLI names the correct type and exact retry command.
- **Target failure / metric:** `c-wrong-type`; primary metric `c-wrong-type` count reduction. Secondary: final correctness, self-recovery, botmap calls after first zero.
- **BEFORE source/subset:** `agenteval-summary-with-retries.json`; minimum subset `beach-accessibility-malta`, `residential-share-cambridge` × 2 repeats. BEFORE on that subset: `{"c-truncated":2,"c-unknown":7,"A":3,"c-wrong-type":3,"B":2,"c-wrong-column":1}`. Exact `c-wrong-type` calls: beach class=beach under `land_use` and `water` where `land` works; residential subtype=military under `building` where `land_use` works.
- **Lever:** Tool first. Add zero-count diagnostic in `count` for same filter across candidate feature types; stderr/JSON should say e.g. `0 rows for -t land_use class=beach, but -t land returns 65. Try ...`.
- **Clone strategy:** `/Users/priyangapkini/workspace/ar-d/botmap-wrong-type-hint` from unchanged botmap baseline; branch `arm-d/wrong-type-hint-tool`.
- **Minimum paired subset:** 4 AFTER attempts. **Full replication:** 30 questions × 2 repeats if minimum drops 3→0 and no large new A/C regression.
- **Evaluator/probe changes needed:** None for minimum; `type_sweep` already produced conclusive evidence. Before full replication, audit that `land` vs `land_use` type naming is real botmap vocabulary, not a probe alias artifact.
- **Stop / invalidation:** Stop if hint text fires on non-zero calls, names a type not accepted by botmap, changes stdout in a way that breaks JSON, or `c-wrong-type` is unchanged with the agent seeing the hint. Invalidate if probe’s alternate type is not actually a valid user-facing `-t` value.
- **Estimated attempts/cost:** 4 AFTER attempts, about **$0.8–$1.4** and 30–60 min. Full bank 60 attempts, about **$15–$18**.

### 2. A→B recovery experiment — backup

- **Hypothesis / principle:** A CLI should convert common raw usage failures into guided recoveries with exact retry commands; agents should self-recover instead of repeating invalid syntax.
- **Target failure / metric:** Class A reduction and self-recovery rate. Secondary: repeated same-error loops, final correctness, calls after first A.
- **BEFORE source/subset:** `agenteval-summary-with-retries.json`; minimum subset `ev-charging-gap`, `pharmacy-near-address`, `pharmacies-monaco`, `junction-density` × 2 repeats. BEFORE: `{"c-truncated":3,"c-unknown":2,"D":1,"A":21}`. Common A patterns: `at ... -t place --category ... --radius ... -n ...` usage errors (17 total in selected subset), `count ... --in Monaco, MC --where categories.primary=pharmacy` usage errors (2), `at ... --json` option-placement error (2).
- **Lever:** Tool. Prefer exact parser-level guidance: preserve failure, but return concise stderr/JSON with accepted syntax and a corrected command. Consider prompt only later if the tool already emits exact guidance and agent ignores it.
- **Clone strategy:** separate clone `/Users/priyangapkini/workspace/ar-d/botmap-usage-retry-hints`; branch `arm-d/a-to-b-usage-hints`.
- **Minimum paired subset:** 8 AFTER attempts. A smaller smoke subset can be just `ev-charging-gap` r2 pattern plus `pharmacy-near-address` × 2, but the planned paired result should use all 8.
- **Full replication:** 30×2 only if A drops materially and no new C bucket appears.
- **Evaluator/probe changes needed:** Pre-run zero-spend triage of A evidence to separate true raw errors from already-guided `no_match` messages. Taxonomy currently classifies some JSON `no_match` messages with “Try ...” as A because `_has_guidance` misses them; fix/audit this before claiming A→B movement.
- **Stop / invalidation:** Stop if the change makes invalid commands silently succeed without clear semantics, or if the agent repeats invalid forms despite exact retry advice (record as class F / ignored hint, not tool success). Invalidate if BEFORE A was evaluator misclassification rather than missing guidance.
- **Estimated attempts/cost:** 8 AFTER attempts, **$1.8–$3.0**; full bank **$15–$18**.

### 3. Full-bank replication of confirmed hints

- **Hypothesis / principle:** The two confirmed tool-side principles generalize beyond small subsets: truncation notices and wrong-column hints reduce silent wrong failures across the whole bank.
- **Target failure / metric:** `c-truncated` and `c-wrong-column`; primary metric matched subtype reduction over all 60 attempts. Secondary: total C, score, self-recovery, tokens/calls.
- **BEFORE source/subset:** Full `agenteval-summary-with-retries.json`: `c-truncated=25`, `c-wrong-column=2` over 60 attempts.
- **Lever:** Tool. Run separately first (`00bff1a` truncation; `7c794ff` wrong-column), then optionally combined branch if individual replication succeeds.
- **Clone strategy:** reuse candidate commits in fresh clones, not working dirs from other arms: `botmap-truncation-repl-00bff1a`, `botmap-wrong-column-repl-7c794ff`, then `botmap-confirmed-hints-combined`.
- **Minimum paired subset:** Already done for both; next meaningful step is full bank.
- **Full replication:** 30 questions × 2 repeats per candidate. Combined run only after individual runs show no broad regressions.
- **Evaluator/probe changes needed:** None, but dashboard should show paired matched deltas by question and subtype.
- **Stop / invalidation:** Stop if cost exceeds budget, if timeout rate exceeds baseline materially, or if total C rises enough to offset target subtype gains. Invalidate broad claim if improvement is concentrated only in original paired questions.
- **Estimated attempts/cost:** 60 attempts per candidate, **$15–$18** each; combined another **$15–$18**.

### 4. Instruction-vs-tool lever comparison

- **Hypothesis / principle:** Some agent-friendliness may belong in agent guidance rather than the CLI; for the same property, prompt-side instruction may or may not match tool-side hint performance.
- **Target failure / metric:** Use `c-truncated` first because tool-side effect exists. Primary: `c-truncated` reduction and self-recovery. Secondary: calls/tokens; instruction may increase prompt tokens but reduce command churn.
- **BEFORE source/subset:** Same as confirmed truncation subset: `bike-parking-coverage`, `basic-category-rollup`, `bus-stops-cambridge` × 2. BEFORE: `{"c-truncated":13,"B":5,"A":3,"c-wrong-column":1,"c-unknown":7}`. Tool AFTER reference: `after-categories-truncation-hint-00bff1a` with `c-truncated=5`.
- **Lever:** Prompt only for the comparison arm: add a project instruction such as “When `categories --top N` returns exactly N items, assume it may be truncated; rerun with a larger `--top` before concluding a category is absent.” Do not include tool-side truncation hint in this run.
- **Clone strategy:** unchanged botmap clone plus instruction candidate branch/worktree. Keep an instruction ID in run name, e.g. `instr-trunc-v1`.
- **Minimum paired subset:** 6 AFTER attempts, same subset/repeats.
- **Full replication:** 60 attempts only if prompt is competitive with tool hint or clearly cheaper.
- **Evaluator/probe changes needed:** None. Need run metadata to record prompt/instruction text for audit.
- **Stop / invalidation:** Stop if instruction leaks answer-specific vocabulary or teaches a botmap-specific hack broader than the property. Invalidate if tool-side candidate is accidentally present.
- **Estimated attempts/cost:** 6 AFTER attempts, **$1.2–$2.0**; full bank **$15–$18**.

## Experiments needing evaluator/probe work first

### 5. Zero-result diagnostics experiment

- **Hypothesis / principle:** Never return an empty count without high-confidence diagnostics: distinguish true zero, unknown vocabulary, wrong column, wrong type, and canonical-value mismatch.
- **Target failure / metric:** `c-unknown` and newly surfaced `c-vocabulary`; primary metric: `c-unknown` should split into explainable subtypes before tool testing, then AFTER should reduce silent C and increase guided B/self-recovery.
- **BEFORE source/subset:** Use `agenteval-summary-with-retries.json`. Minimum subset `asian-restaurants-rollup`, `bus-stops-cambridge`, `ev-charging-gap` ×2 has BEFORE `{"c-truncated":10,"c-unknown":12,"B":1,"A":16,"D":1}`. Expanded subset adding `bike-parking-coverage`, `beach-accessibility-malta` has `c-unknown=19`.
- **Lever:** Both, but sequence tool first only after probes are fair. Tool lever: `count` emits diagnostic when zero is suspect and gives safe discovery commands. Prompt lever later: instruct agent to run safe zero-result probes.
- **Clone strategy:** evaluator/probe work in autoresearch branch first; tool candidate in separate `botmap-zero-diagnostics` clone only after probe gate passes.
- **Minimum paired subset:** 6 AFTER attempts after probe work; expanded 10 attempts if cheap and stable.
- **Full replication:** 60 attempts after minimum shows fewer silent wrongs without creating noisy false hints.
- **Evaluator/probe changes needed before fair:** Improve vocabulary/canonicalization probes for `categories.primary`, unsupported columns (`taxonomy.primary`, `basic_category`), street canonical forms (`Massachusetts Avenue` vs `Massachusetts Ave`), and true-zero detection. Add sabotage fixtures for each split. Avoid MA/MT-style artifacts.
- **Stop / invalidation:** Stop if `c-unknown` cannot be reliably split, if diagnostics advise commands that do not work, or if many true-zero results are framed as errors.
- **Estimated attempts/cost:** Probe work costs no model spend; minimum AFTER **$1.2–$2.2**; expanded **$2–$3.5**; full bank **$15–$18**.

### 6. Entity resolution echo experiment

- **Hypothesis / principle:** Confirm what was resolved, including country/region, so agents catch ambiguous places before querying the wrong entity.
- **Target failure / metric:** `c-wrong-entity`; primary metric on deliberately ambiguous locations: wrong-entity probe count and final correctness. Current Phase 4 has **no valid** `c-wrong-entity` after MA/MT repair.
- **BEFORE source/subset:** Existing run is insufficient except as negative control. Need a small ambiguous-location mini-bank with Malta MT/MT country, Cambridge MA/UK, Portland ME/OR, Paris TX/FR, etc.
- **Lever:** Tool first: `where --json` and any command with `--in` echoes resolved `{name,country,region,type}` in JSON and concise stderr. Prompt later: “verify resolved entity when qualifier ambiguous.”
- **Clone strategy:** evaluator/question mini-bank branch plus `botmap-entity-echo` clone.
- **Minimum paired subset:** 4–6 questions ×2 repeats once probes pass.
- **Full replication:** Not applicable until mini-bank proves signal; then maybe merge into full bank.
- **Evaluator/probe changes needed:** Add deliberate ambiguous fixtures and stronger entity probe tests, especially US state vs ISO code precedence. Confirm echo is classified as guidance, not failure noise.
- **Stop / invalidation:** Stop if probe confuses abbreviations again or if echo is not visible in the transcript command path agents actually use.
- **Estimated attempts/cost:** Probe/fixture work free; mini-bank 8–12 attempts **$2–$4**.

### 7. Discovery command experiment

- **Hypothesis / principle:** Make discovery first-class: targeted category/value search reduces guessing, truncation, token use, and wrong final conclusions.
- **Target failure / metric:** Token/call reduction, `c-truncated`, `c-unknown`, final correctness. This is broader than one subtype.
- **BEFORE source/subset:** Candidate subset `asian-restaurants-rollup`, `bike-parking-coverage`, `bus-stops-cambridge`, `ev-charging-gap`, `tattoo-category-discovery` ×2. BEFORE: `{"c-truncated":15,"c-unknown":15,"B":4,"c-wrong-column":1,"A":16,"D":1}` plus high botmap call count (133 calls over 10 attempts).
- **Lever:** Tool (`categories --search TERM`, perhaps `values --search --type --field`). Prompt comparison later if needed.
- **Clone strategy:** `botmap-categories-search` clone; branch `arm-d/discovery-search-command`.
- **Minimum paired subset:** 6 attempts first (`asian-restaurants-rollup`, `bus-stops-cambridge`, `ev-charging-gap` ×2), then 10 attempts.
- **Full replication:** 60 attempts only after minimum shows the agent naturally discovers/uses the command.
- **Evaluator/probe changes needed before fair:** Runner/evaluator should record command/token/wall-clock deltas reliably and distinguish discovery-command use from existing truncation hint effects. Ideally run after full-bank truncation replication or on a baseline without truncation hint to isolate discovery.
- **Stop / invalidation:** Stop if agents do not discover the command without prompt/tool help, if search results are too broad/noisy, or if improvements are entirely explained by truncation notice already confirmed.
- **Estimated attempts/cost:** 6 attempts **$1.2–$2.2**; 10 attempts **$2–$3.5**; full bank **$15–$18**.

## Likely too confounded / expensive for this wave

### 8. Progress/estimate experiment

- **Hypothesis / principle:** Long operations should emit progress/cost estimates so agents do not abandon correct commands as hangs.
- **Target failure / metric:** Class D, abandonment/timeouts, wall-clock. Current D=3 only.
- **BEFORE source/subset:** `ev-charging-gap`, `hardware-near-bikepaths`, `tall-buildings-cambridge` ×2. BEFORE: `{"c-truncated":3,"c-unknown":2,"D":3,"A":14}`. D calls: `where Cambridge, MA --geometry` (2) and `--json containing 42.3653,-71.0649` (1).
- **Lever:** Tool: progress/estimate to stderr for known expensive geometry/containing routes; possibly prompt: prefer bbox or cheaper summary first.
- **Clone strategy:** `botmap-progress-estimates` clone only after a cheap CLI-only timing audit identifies deterministic long routes.
- **Minimum paired subset:** 6 attempts, but only 3 D events; weak signal.
- **Full replication:** Not recommended now.
- **Evaluator/probe changes needed:** Improve D detection beyond fixed `duration>=600`; record abandonment and silence intervals, not just final duration.
- **Stop / invalidation:** Stop if D cannot be distinguished from model deliberation, cache variance, or network/data slowness.
- **Estimated attempts/cost:** Timing audit free/cheap; paired 6 attempts **$1.5–$2.5**, but low information gain.

## Dependencies and sequencing

1. **Do wrong-type hint first** (ready, small, directly tests a remaining class-C subtype).
2. In parallel planning only, **triage A classifications without model spend**; fix taxonomy if guided `no_match` is currently mislabelled as A. Then run A→B as backup/second.
3. Do **instruction-vs-tool** after wrong-type or after A→B if we need a non-tool lever answer quickly.
4. Do **full-bank replication** once small candidates are stable and budget is approved.
5. Only then spend on **discovery** or **zero diagnostics**; both need better attribution to avoid overclaiming.
6. Leave **entity echo** and **progress** as mini-bank/instrumentation projects, not next paid paired runs.

## Recommended first and backup

- **First:** Wrong-type hint, tool lever, 4-attempt subset (`beach-accessibility-malta`, `residential-share-cambridge` ×2). It has a crisp BEFORE (`c-wrong-type=3`), minimal evaluator risk, and likely cost under $1.50.
- **Backup:** A→B recovery after zero-spend A triage. If taxonomy triage shows A is mostly genuine raw usage errors, this targets the largest remaining charged bucket.

## Dashboard cards

Add one card per active planned/run experiment:

- `Arm D: wrong-type hint` — candidate sha, subset, attempts done/total, cost, `c-wrong-type BEFORE→AFTER`, total C/A/B, completion count.
- `Arm D: A→B recovery` — A BEFORE→AFTER, repeated-error loops, self-recovery rate, ignored-hint count.
- `Arm D: lever comparison` — tool vs instruction side-by-side: subtype delta, calls, tokens, wall-clock, cost.
- `Arm D: full-bank replication` — 60-attempt progress, subtype deltas, regression alerts, timeout count.

Run names should be stable and grep-friendly:

```text
experiments/runs/after-wrong-type-hint-tool-<sha>/
experiments/runs/after-a-to-b-usage-hints-tool-<sha>/
experiments/runs/after-truncation-instruction-instr-v1/
experiments/runs/after-confirmed-hints-fullbank-<sha>/
```
