# Arm C insights — full-repo context + full edit optimizer

## 1. What this arm was testing

Arm C tested whether GEPA does better when it can see the whole botmap repository and edit almost the whole tool surface, while being scored by the new `autoresearch/agenteval` evaluator rather than the legacy proxy scorer.

The intended distinction from the other arms was breadth:

- **Full read context:** `--full-repo-context` supplied a bounded snapshot of the tracked botmap repo to the proposer.
- **Full edit surface:** `--all-files` let GEPA edit tracked UTF-8 text files, excluding evaluator files after the safety corrections below.
- **New evaluator:** candidate feedback and objective were wired through record-v2, `agenteval.score`, `agenteval.explain`, and the sabotage gate.

This arm was not primarily a claim that a broad GEPA run would produce a shippable patch. It was a test of whether broad context lets the proposer identify the real homes of agent-usability failures.

## 2. What ran / did not run

### Shared autoresearch wiring

Before launch, Arm C wired future optimizer/evaluator scoring to the new evaluator path:

- `autoresearch/evaluator.py` builds record-v2 attempts and scores with `autoresearch.agenteval.score.score_record`.
- GEPA feedback uses `autoresearch.agenteval.explain.explain(record)`.
- attempt-level environment/quota failures are excluded rather than charged to candidates.
- baseline summaries use agenteval correctness/recoverability.
- `CORRECTNESS_IMPL` was changed to `agenteval-v2` before later shared commits.
- optimizer sabotage gate runs before the paid path.

Local test status at launch time: `uv run pytest` passed with 141 tests after Arm C wiring.

### Full-repo optimizer support commits from orchestrator

Known shared commits relevant to Arm C:

- `686cce1 Allow full repo optimizer context and edits`
  - first implementation of `--all-files` and `--full-repo-context`.
- `7ce1b31 Keep evaluator files out of full repo optimizer edits`
  - excluded `evals/*` after user clarified evaluator files must not be edited.
- `51a609c Exclude evaluator-adjacent tests from full repo optimizer`
  - excluded evaluator-adjacent test files too.

### Invalid runs

These must not be compared or reused:

1. `experiments/runs/tool-3009509-1787544884/`
   - invalid because the editable seed included `botmap/evals/*`.
   - marked with `INVALID.md`.

2. `experiments/runs/tool-3009509-1787550341/`
   - invalid because it excluded `evals/*` but still allowed evaluator-adjacent test files.
   - marked with `INVALID.md`.

### Corrected Arm C run

Run directory:

```text
experiments/runs/tool-3009509-1787550419/
```

Launch log:

```text
experiments/runs/arm-c-full-repo-no-evaluator-launch-20260824-111659.log
```

Target botmap repo:

```text
/Users/priyangapkini/workspace/ar-c-new/botmap @ 3009509
```

Command shape:

```bash
BOTMAP_REPO=/Users/priyangapkini/workspace/ar-c-new/botmap \
  uv run python -m autoresearch.optimize \
    --lever tool \
    --all-files \
    --full-repo-context \
    --budget 60 \
    --keep-runs
```

Run facts from `summary.json` and launch log:

- editable files: **83** tracked UTF-8 text files, excluding evaluator and evaluator-adjacent files.
- full repo context: **556,909 chars**.
- budget requested: **60**.
- evaluations run: **62**.
- candidates tried: **4**.
- duration: **1496.0 minutes** (~24.9 hours).
- finished: `2026-08-25T06:42:59.452994+00:00`.
- proposer: `openrouter/anthropic/claude-opus-5`.
- agent path recorded in summary: `subscription`, provider `anthropic-subscription`, model `sonnet`.
- baseline: reused cached yardstick for `3009509`.
- release/network preflight notes: could not ask tool release and could not test map-data link, so snapshot/network comparability was unchecked rather than positively validated.

The experiment halt arrived later. Treat any active processes at halt as intentionally stopped, but this corrected Arm C run appears to have reached its normal optimizer end before that halt.

## 3. Key quantitative results so far

### Optimizer output

The best patch changed only:

```text
.gitignore
```

Patch size:

```text
167 lines in experiments/runs/tool-3009509-1787550419/change.patch
```

The patch is not a useful botmap behavior change. It mostly adds comments, anchors ignore patterns, ignores output artifacts, and embeds `NEW FILE NEEDED` requests. It should be read as proposer reasoning, not as a candidate to ship.

### Retained record-v2 attempt summary for the corrected run

A local summary over retained `record-v2.json` files in the run directory produced:

```json
{
  "records": 52,
  "attempts_with_failures": 23,
  "class_counts": {"clean": 188, "A": 13, "B": 9, "C": 22, "E": 12},
  "subtype_counts": {"c-unknown": 22},
  "agent_side_counts": {}
}
```

Caution: this is **not** a clean final measurement distribution for a single patch. It is retained optimizer-attempt evidence across candidate evaluations, without post-run probe enrichment. The `c-unknown` bucket therefore says more about missing enrichment in this optimizer path than about the underlying CLI property.

### Files GEPA asked for

The strongest repeated new-file requests were:

- `botmap/errors.py` — **2x**
  - reason: route STAC/S3/network failures through one handler that prints problem + ready-to-run replacement instead of raw traceback.
- `botmap/zero_results.py` — **2x**
  - reason: shared zero-result explainer for `count`, `sample`, `roads`, `water`, `landuse`, `addresses`, not only the existing places path.
- `botmap/placenames.py` — **2x**
  - reason: diacritic folding/transliteration/endonym aliases, e.g. `Reykjavik -> Reykjavík`.
- `botmap/suggest.py` — **2x**
  - reason: unknown-subcommand/verb suggestions plus alias table, plural/singular and hyphen/underscore variants.

There were many one-off noisy file requests, including paths outside the intended boundary and evaluator-looking names. The repeated four above are the meaningful signal.

## 4. Qualitative insights about agent-friendly CLI design

1. **Broad context mostly helped the proposer name missing abstractions, not produce a patch.**
   The best output was a `.gitignore` edit, but the reasoning repeatedly identified plausible architectural homes for failures: shared zero-result explanation, shared network/error handling, place-name normalization, and suggestion/alias logic.

2. **Agent-friendly behavior wants cross-command consistency.**
   The repeated `botmap/zero_results.py` request is important: a hint implemented only in one command path is not an agent-friendly property. Agents encounter the same semantic failure through many verbs. The CLI should centralize “zero but maybe you asked wrong” behavior.

3. **Raw environmental failures are still part of the interface contract.**
   `botmap/errors.py` emerged because network/S3 failures reach agents as tracebacks. Even if the root cause is environment, an agent-friendly CLI should distinguish transient data-access failure from bad command syntax and give retry/scope advice.

4. **Place-name normalization is an agent-facing feature.**
   The `placenames.py` request matches the Reykjavik/diacritic class of failures. Agents type common ASCII names. If the data index requires local spelling, the CLI needs normalization or explicit alternatives.

5. **Suggestion machinery should be generic, not ad hoc.**
   `botmap/suggest.py` points to a general design property: aliases, singular/plural repair, hyphen/underscore repair, and near-match suggestions belong in a reusable suggestion layer rather than being scattered through commands.

6. **Full-repo edit surfaces are dangerous without sharp boundaries.**
   Two invalid runs happened before the boundary excluded evaluator and evaluator-adjacent files. Full-repo mode must be explicit about what is subject and what is measurement apparatus.

## 5. What claims are supported vs tentative

### Supported

- The new evaluator can run through the optimizer path: the corrected run used `correctness_impl: agenteval-v2`, produced record-v2 artifacts, and completed.
- Full-repo context plus broad edit permission caused GEPA to identify recurring missing modules/abstractions related to agent-friendly CLI behavior.
- The run does **not** support shipping the generated `.gitignore` patch as a CLI improvement.
- Excluding evaluator files from the edit surface is necessary; otherwise the optimizer can propose changes to the measurement apparatus.

### Tentative

- That `botmap/zero_results.py`, `botmap/errors.py`, `botmap/placenames.py`, or `botmap/suggest.py` are the correct module boundaries. They are plausible because they were repeated and align with measured failures, but they are still proposer suggestions.
- That full-repo GEPA is cost-effective. This run took ~25 hours, tried only 4 candidates, and changed no behavior.
- That the retained run histogram reflects true CLI failure distribution. It lacks post-run probe enrichment and spans optimizer candidates.
- That the reused baseline was strictly comparable. The run proceeded with release and network checks unchecked, not confirmed healthy.

## 6. Failure modes / confounders / invalid runs

- **Invalid edit surfaces:**
  - `tool-3009509-1787544884` included `evals/*` and is invalid.
  - `tool-3009509-1787550341` excluded `evals/*` but still included evaluator-adjacent tests and is invalid.

- **Very wide search with small effective per-file budget:**
  - The corrected run covered 83 files with budget 60. The optimizer itself warned this gives approximately zero evaluations per file. This likely explains why only 4 candidates were tried and why the best patch landed in `.gitignore` rather than a behavior file.

- **Boundary leakage in wanted-file analysis:**
  - `blocked-files.txt` includes many noisy one-off paths, including evaluator-looking names and malformed names. Treat repeated, semantically coherent requests as signal; do not mechanically create every requested file.

- **No post-run probe enrichment:**
  - The retained optimizer attempts classify many empty failures as `c-unknown`. That is expected without differential probes and should not be treated as a final property distribution.

- **Unvalidated release/network comparability:**
  - Preflight could not ask the tool for release or test the map-data link. It continued, but the result is weaker than a run with positive release/network validation.

- **Generated patch is not behaviorally useful:**
  - The `.gitignore` patch embeds `NEW FILE NEEDED` comments and ignore-pattern changes. It is evidence about proposer reasoning, not a CLI fix.

## 7. Recommendation for next experiments

1. **Do not run another 83-file budget-60 optimizer pass.**
   It is too broad for the budget. If full-repo mode is used again, either raise the budget substantially or use it only as a discovery/planning pass.

2. **Turn the repeated module requests into a human-reviewed implementation plan.**
   The most promising slices are:
   - shared zero-result explainer (`botmap/zero_results.py` or equivalent),
   - shared data-access/error formatter (`botmap/errors.py` or equivalent),
   - place-name normalization (`botmap/placenames.py` or equivalent),
   - generic suggestion/alias engine (`botmap/suggest.py` or equivalent).

3. **Run small paired experiments per property, not one broad optimizer run.**
   For example:
   - implement zero-result explainer for one command family, then rerun the affected questions;
   - implement diacritic normalization, then rerun `reykjavik-diacritic` and related place-name questions;
   - implement network/error formatting and validate with local/offline failure fixtures, not a paid stochastic run first.

4. **Keep evaluator and evaluator-adjacent files excluded from any optimizer edit surface.**
   Full repo context can remain read-only; edit permission must stay on subject code only.

5. **Add post-run enrichment for optimizer-retained attempts before deriving histograms.**
   Otherwise optimizer evidence will overproduce `c-unknown` and understate specific design properties.

## 8. Anything the blog / derivation sessions should know

- The strongest Arm C result is not “GEPA found a patch.” It is “with enough context, the proposer rediscovered the missing abstractions behind the measured properties.”
- The `.gitignore` patch is a useful anecdote about optimizer misalignment: when the edit surface is too wide and the budget too thin, the optimizer may use any editable file as a place to write advice rather than changing behavior.
- The run reinforces the project’s central thesis: agent-friendly CLI work is mostly observability and self-description, not core capability. The repeated asks were about explaining zeros, formatting errors, normalizing names, and suggesting repairs.
- The invalid runs are blog-worthy cautionary material: if the optimizer can edit the evaluator, or even evaluator-adjacent tests, the experiment can no longer claim it improved the subject rather than the ruler.
- Do not overclaim score movement from Arm C. The best patch did not change a relevant behavior, and the retained histograms are incomplete without probe enrichment.
