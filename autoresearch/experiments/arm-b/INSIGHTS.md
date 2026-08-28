# Arm B insights — prompt lever with agenteval-v2

## 1. What this arm was testing

Arm B tested the prompt/instructions lever only: can changing `botmap/data/skill.md`, without changing botmap code or `botmap/evals`, make the CLI easier for an agent to drive under the new agenteval rubric?

The intended comparison is later against:

- Arm A: an agent runs the research loop as a skill, without GEPA.
- Arm C: broader/full-repo tool context and edits.

For this arm, the editable surface was `botmap/data/skill.md` only. The scientific question was not just “does the score increase?” but whether prompt-side instructions can teach recovery behaviours that an agent-friendly CLI would otherwise need to surface itself: zero-result diagnosis, field/type selection, place-resolution checks, truncation caution, and avoiding large downloads.

## 2. What ran / did not run

### Evaluator and harness readiness

Before the optimizer run, the shared checkout had the new evaluator path wired:

- `autoresearch/agenteval/contract.py`, `taxonomy.py`, `probe.py`, `score.py`, `explain.py`, `record.py`, `agent_side.py`, `sabotage.py`, `analyze.py`, `enrich.py`, `repair.py`
- `autoresearch/runner.py` writing `record-v2.json` when attempts are retained
- `autoresearch/evaluator.py` using `agenteval.score` and `agenteval.explain`
- `autoresearch/baseline.py` summarising baseline correctness through agenteval
- `autoresearch/optimize.py` recording `correctness_impl: agenteval-v2`

Relevant commits visible before launch included:

- `2911c1f Add agent evaluator contract and taxonomy`
- `e84e248 Wire record-v2 artifacts for retained attempts`
- `1ab4496 Add evaluator run analysis scaffold`
- `de7777b Add post-run probe enrichment`
- `7b0bdc4 Summarize measurement runs with completed retries`
- `0a75991 Apply recovery-centered evaluator rubric`
- `89acc62 Fix entity probe state-code ambiguity`
- `9ed2a19 Probe category vocabulary from CLI listings`
- `686cce1 Allow full repo optimizer context and edits`
- `7ce1b31 Keep evaluator files out of full repo optimizer edits`

The sabotage gate passed immediately before launch using the taxonomy classifier and the attempt-level quota check. The full test suite passed immediately before launch:

```text
uv run pytest
141 passed in 0.40s
```

The global Claude botmap skill was absent, so the project skill was not shadowed.

### Optimizer run

Launched command shape:

```bash
cd /Users/priyangapkini/nilenso/ai-playground/autoresearch
set -a
source .env
set +a
BOTMAP_REPO=/Users/priyangapkini/workspace/ar-b-new/botmap \
  uv run python -m autoresearch.optimize \
    --lever prompt \
    --budget 60 \
    --keep-runs
```

Run artifacts:

```text
experiments/runs/arm-b-prompt-launch-20260824-094552.log
experiments/runs/prompt-3009509-1787544952/
```

Botmap repo:

```text
/Users/priyangapkini/workspace/ar-b-new/botmap @ 3009509
```

Preflight at launch:

```text
map data: NOT pinned — release 2026-08-19.0, matching the cached baseline
link to map data: 6/6 test calls ok, median 9s, spread 1.8x
proposals from: openrouter/anthropic/claude-opus-5 (OpenRouter balance $61.34)
lever 'prompt' covers 1 file(s): botmap/data/skill.md
25 questions to learn from, 5 held back to check
reusing the yardstick measured earlier for 3009509
```

The run finished on 2026-08-24, before the later experiment halt. It was not one of the intentionally terminated incomplete runs on 2026-08-25.

### What did not run

- No manual edits to `botmap/evals`.
- No prompt-arm run with `--all-files` or full-repo context.
- No post-run probe enrichment summary was found for this prompt run at the time of this report. The retained `record-v2.json` files exist, but the class-C subtype information in the run directory is therefore under-enriched compared with the Phase 4 enriched summaries.
- No paired before/after prompt-lever experiment was run from the best candidate, because GEPA selected the unchanged base as best.

## 3. Key quantitative results so far

Run summary from `experiments/runs/prompt-3009509-1787544952/summary.json`:

```json
{
  "lever": "prompt",
  "files": ["botmap/data/skill.md"],
  "files_changed": [],
  "sha": "3009509",
  "correctness_impl": "agenteval-v2",
  "agent_path": "subscription",
  "agent_provider": "anthropic-subscription",
  "agent_model": "sonnet",
  "proposer": "openrouter/anthropic/claude-opus-5",
  "budget": 60,
  "evaluations_run": 63,
  "candidates_tried": 5,
  "minutes": 712.2
}
```

Important score trace from GEPA:

```text
Base full valset score: 0.7171183364842026 over 5 / 5 examples
Candidate full valset scores:
  iteration 2: 0.6158909004401625
  iteration 5: 0.4947683096963408
  iteration 6: 0.5220595289553529
  iteration 7: 0.6955642283862925
Best score on valset stayed: 0.7171183364842026
Best program: base program 0
files_changed: []
change.patch: empty
```

A local zero-spend summary of retained prompt-run artifacts found:

```text
attempt dirs: 52
completed attempts: 49
ok attempts: 49
botmap calls: 201
transcript cost recorded: $10.1320
record-v2 files: 52
attempts with failures: 15
class counts: clean=159, E=16, C=4, A=12, B=5
subtype counts: c-unknown=4
agent-side counts: none recorded
```

Caution: those class/subtype counts are from retained per-attempt record-v2 artifacts as written during the run, not from a completed post-run probe-enrichment pass. They should be treated as a partial diagnostic, not as the final prompt-arm class distribution.

Blocked-file scanner output:

- Existing out-of-scope mentions: `botmap/__init__.py` mentioned 5 times.
- Proposed new files:
  - `botmap/normalize.py` asked for 2 times — diacritic/ASCII-folding and fuzzy candidate matching for division lookup.
  - `botmap/nearby.py` asked for 2 times — first-class spatial join / “near” operation between feature sets.
  - `botmap/placematch.py` asked for 1 time — alias-aware place matching and ready-to-run bbox/no-match advice.
- Scanner also captured many absolute paths in `.venv` / Python / `litellm` / `httpx` stack traces as “wanted files”; these are false positives from a proposer network failure, not meaningful botmap edit requests.

## 4. Qualitative insights about agent-friendly CLI design

1. **Prompt instructions can encode recovery procedures, but GEPA did not find a prompt that beat the base on held-out questions.** Several candidates were plausible and detailed, especially around zero-result diagnosis and place-name recovery, but held-out score regressed or nearly matched rather than improved.

2. **Instructions drift toward long manuals.** The proposed skill files became much longer and more prescriptive. They added useful protocols, but also increased the cognitive surface an agent must search. This may explain why plausible prompt changes did not improve valset score.

3. **The optimizer repeatedly rediscovered that some fixes belong in the CLI, not the prompt.** Requests for `normalize.py`, `placematch.py`, and `nearby.py` point to properties that are hard to solve reliably with prose: canonical name lookup, fuzzy/diacritic matching, no-match recovery, and spatial joins.

4. **Zero-result recovery is central but fragile as an instruction.** Candidate prompts repeatedly emphasized “a count of 0 is not an answer” and diagnostic ladders. That is the right design property, but forcing the agent to remember and execute a multi-step ladder is weaker than the CLI surfacing “you used the wrong field/type/value” directly.

5. **Prompt-side examples can accidentally preserve false vocabulary.** Candidates sometimes continued to list misleading values such as `bus_stop` as a place category or `land_use class=recreation/agriculture`, even though earlier evidence showed column/type traps around this vocabulary. This supports the “advertise only values that work” property: docs and skill files are part of the interface, and stale examples are defects.

6. **Agent-friendly CLI design appears to be observability-heavy, not feature-heavy.** The best candidate stayed unchanged, while the useful learned proposals were mostly “the tool should say what happened”: wrong place, wrong field, wrong type, no progress, no direct spatial operation.

## 5. Supported vs tentative claims

### Supported

- The prompt-lever optimizer run did not produce an accepted held-out improvement over the base skill file. The best program was the base and `change.patch` is empty.
- The run used the new evaluator scoring path (`correctness_impl: agenteval-v2`) and retained record-v2 artifacts.
- Prompt candidates repeatedly converged on recovery instructions for zero results, place resolution, quoting, and avoiding global downloads.
- GEPA’s blocked-file requests are evidence that the prompt lever ran into code-level limitations, especially place normalization and spatial joins.

### Tentative

- “Prompt-only is insufficient” is not fully proven. This was one run, with five candidate programs and five held-out questions; a human-designed prompt patch or a smaller targeted paired experiment could still work.
- The retained run class histogram is tentative because post-run enrichment was not found/completed for this prompt run.
- The comparison to Phase 4 and to other arms requires care because this run summary records `agent_path: subscription` / `agent_provider: anthropic-subscription`, while some earlier measurement/probe paths used OpenRouter-mediated Claude. The proposer used OpenRouter, but the map-question answering agent path recorded as subscription.
- Cost accounting from transcripts ($10.1320 in retained attempts) is lower than a naive 60×2 estimate because only retained attempt directories were counted locally and GEPA caching/subsampling changes the actual number of paid attempts.

## 6. Failure modes / confounders / invalid runs

- **Proposer network failure:** iteration 3 hit `litellm.APIError: OpenrouterException - [Errno 8] nodename nor servname provided, or not known`. GEPA recovered enough to continue, but the blocked-file scanner later misread stack-trace paths as new-file requests. Treat the `.venv`, `httpx`, `httpcore`, `litellm`, `gepa`, and Python stdlib “wanted files” as scanner noise.

- **No final prompt change:** because the base remained best, there is no prompt patch to apply or paired AFTER experiment to interpret.

- **Record enrichment gap:** the prompt-run artifacts have `record-v2.json`, but no `agenteval-summary.json` was present in the run directory. Class-C subtypes are mostly `c-unknown`; do not use this as the final taxonomy distribution without enrichment.

- **Potential billing-path comparability issue:** launch preflight and summary record the agent path as subscription. The proposer was OpenRouter. If the intended Arm B comparison required all map-question attempts through OpenRouter, this run should be labelled accordingly rather than silently compared as identical.

- **Unpinned map data:** preflight matched release `2026-08-19.0` to the cached baseline at launch, but botmap remains unpinned by design. Long runs can still be sensitive to release/cache changes.

- **Dashboard paths:** existing dashboard configuration previously pointed Arm B at the old `~/workspace/ar-b` paths. The actual prompt run used `/Users/priyangapkini/workspace/ar-b-new/botmap`.

- **Intentionally halted later experiments:** the user halted experiments on 2026-08-25T16:42:21Z. Any run active then should be treated as intentionally stopped, not failed. This Arm B prompt run had already finished on 2026-08-24.

## 7. Recommendation for next experiments

1. **Do not run another open-ended prompt GEPA immediately.** This run produced no accepted prompt improvement and suggests the search space is noisy for long instruction files.

2. **Run targeted prompt-vs-tool paired experiments instead.** Pick one property at a time, with a small matched subset and the same agent conditions:
   - zero-result protocol as prompt text vs count/type/field hints in tool output;
   - place-name/diacritic recovery as prompt ladder vs `where` no-match hint;
   - spatial-join instructions vs a first-class `near`/join command.

3. **Enrich the prompt-run record-v2 files offline before drawing class-distribution conclusions.** This is CLI-only/no-model if run later, but should wait until the halt is lifted.

4. **Fix or filter blocked-file scanner noise.** Absolute stack-trace paths from proposer infrastructure should not become “NEW FILE NEEDED” recommendations.

5. **Make billing path explicit before future runs.** Decide whether Arm B’s map-question agent should be subscription or OpenRouter-mediated, then record and compare only like with like.

6. **Consider a shorter, property-indexed skill rather than a longer manual.** If prompt work continues, the hypothesis to test is that agents benefit from compact decision tables and hard anti-patterns more than encyclopedic recipes.

## 8. Anything the blog/derivation sessions should know

- A negative optimizer result is useful here: when the prompt-only arm tried to improve the interface, the best held-out result was the original prompt. The candidate text looked subjectively better, but measurement did not reward it.

- GEPA’s failed prompt candidates are still evidence. They read like a list of missing CLI affordances: normalize names, suggest bboxes, name the right field/type, add a spatial join, and show progress. This supports the broader thesis that agent-friendly CLI design is about making state and recovery visible at the tool boundary.

- “Instructions can paper over interface gaps” is only partly true. The candidates could tell the agent what to do after a zero, but they could not reliably make the agent notice, remember, and apply the protocol under task pressure.

- The most blog-worthy contrast is between subjective prompt quality and measured agent behaviour: adding more careful instructions can make a skill file feel safer while still reducing held-out performance.

- Be careful not to conflate proposer failures with product insights. The OpenRouter DNS/proposer failure generated scary stack traces and bogus wanted-file paths; that is an experiment-infrastructure lesson, not a botmap design property.
