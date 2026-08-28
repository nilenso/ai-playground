# General principles for agent-friendly CLIs

This memo synthesizes the autoresearch/botmap evidence so far. It answers the general research question cautiously: botmap is one CLI testbed, so cross-CLI replication is still needed before claiming universality. The strongest current claims are therefore “confirmed in botmap, plausible for CLIs with analogous behavior.”

Evidence used:

- `docs/agent-friendly-cli.md`
- `experiments/paired/categories-truncation-hint/result.md`
- `experiments/paired/count-wrong-column-hint/result.md`
- `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`
- `experiments/arm-d/PLAN.md`
- DERIVATION session observations from the same files

Baseline corrected measurement:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2}
}
```

## Core answer

An agent-friendly CLI makes its interpretation, uncertainty, completeness, and recovery paths explicit. The key failure mode is not only “the command crashed.” It is often worse: the command exits successfully with an ambiguous zero, capped list, or plausible but incomplete output, and the agent turns that into a confident wrong answer.

Human-friendly CLIs can often rely on terse output, implicit defaults, and a human’s suspicion that “this seems incomplete.” Agent-friendly CLIs cannot. They should be designed as conversational instruments for shell-based reasoning: every ambiguous result should expose enough state for the next command to be correct.

---

# 1. Principles supported by paired evidence

## 1. Never silently truncate output

**Statement:** If a CLI returns a limited or capped list, it must say the output is incomplete and name the exact command or option needed to retrieve complete data.

**Evidence / failure class:** Class C / `c-truncated`. In the baseline, category discovery calls often returned exactly the requested `--top N`; a limit-raise probe found more rows. In the paired experiment, adding a truncation warning to `botmap categories` reduced `c-truncated` failures from 13 BEFORE to 5 AFTER on the matched three-question subset.

**Confidence:** Confirmed in botmap; provisional as a general CLI principle pending replication elsewhere.

**Design implication:** Every CLI command with `--limit`, `--top`, pagination, sampling, default caps, or display truncation should report:

- how many items were shown,
- whether more exist,
- total count if known,
- exact recovery action, e.g. `rerun with --limit TOTAL`, `use --page-token`, or `add a narrower filter`.

Prefer preserving machine-readable stdout and putting concise guidance on stderr or structured metadata.

## 2. If a value exists elsewhere, say where

**Statement:** When a query returns zero because a known value was used in the wrong field, the CLI should identify the correct field and provide the corrected filter.

**Evidence / failure class:** Class C / `c-wrong-column`. Baseline examples: `subtype=bicycle_parking` returned 0 while `class=bicycle_parking` returned 1,844; `subtype=government` returned 0 while `class=government` returned 23. In the paired experiment, a `count` hint for likely `class`/`subtype` swaps reduced `c-wrong-column` from 2 BEFORE to 0 AFTER on the matched two-question subset.

**Confidence:** Confirmed narrowly in botmap; provisional as a general structured-query CLI principle.

**Design implication:** CLIs with schemas should validate field/value compatibility. If the value is known in another field, say so with counts and an exact retry command. Keep this high-confidence: exact value match beats fuzzy guesswork.

---

# 2. Principles suggested by baseline traces, not yet confirmed

## 3. Do not return an unexplained zero

**Statement:** A zero result should distinguish “there are truly no matching records” from “the query may be malformed, mismatched, unsupported, or incomplete.”

**Evidence / failure class:** Class C, especially `c-unknown` = 25, tied with `c-truncated` as the largest subtype bucket. Many empty `count` calls exited successfully with no conclusive probe explanation.

**Confidence:** Hypothesis. Strong baseline signal, but no paired intervention yet.

**Design implication:** Empty results should include diagnostic context: recognized filters, unrecognized values, valid fields, searched type, and safe next probes. For JSON CLIs, include a structured `diagnostics` object.

## 4. Name the fix, not just the problem

**Statement:** Errors should provide a next command, not only usage text or a complaint.

**Evidence / failure class:** Class A = 38 hard/unguided failures. Examples include usage-only errors such as `Usage: python -m botmap count [OPTIONS]` with no local correction. The taxonomy intentionally treats guided errors as B and near-free because they can enable self-recovery.

**Confidence:** Hypothesis for direct paired evidence; conceptually supported by the scoring framework.

**Design implication:** Replace raw usage dumps with contextual recovery: offending argument, reason, valid alternatives, and exact command template. A parser error should be a repair step.

## 5. Make discovery first-class

**Statement:** Agents should not need to guess names, grep huge outputs, or raise arbitrary limits to discover valid values.

**Evidence / failure class:** `c-truncated`, `c-vocabulary`, `c-unknown`, token/call waste. The confirmed truncation result shows that discovery output incompleteness hurts agents, but targeted discovery commands have not been tested yet.

**Confidence:** Hypothesis.

**Design implication:** Provide commands like `schema`, `fields`, `values --field`, `categories --search`, `explain-filter`, and examples that are complete enough to compose.

## 6. If data lives under another type or verb, name that route

**Statement:** If the same filter has rows under a different resource type or subcommand, the CLI should say which route works.

**Evidence / failure class:** Class C / `c-wrong-type` = 3. Examples: `land_use class=beach` returned 0 while `land class=beach` returned 65; `building subtype=military` returned 0 while `land_use` returned 1.

**Confidence:** Hypothesis; Arm D marks this as the highest ready-to-run next paired experiment.

**Design implication:** Multi-resource CLIs should detect likely type/verb mismatches and print exact alternatives, e.g. “0 under `-t land_use`, but 65 under `-t land`; try ...”.

## 7. Confirm what the CLI resolved or inferred

**Statement:** When the CLI resolves ambiguous user input, it should echo the resolved entity, scope, account, region, namespace, time range, or default used.

**Evidence / failure class:** Candidate for `c-wrong-entity`, but current valid baseline has no confirmed `c-wrong-entity` after repairing MA/MT false positives. The evaluator initially mistook US state abbreviations for ISO country codes, proving that ambiguity itself is real and dangerous.

**Confidence:** Hypothesis / defensive principle, not confirmed by current paired evidence.

**Design implication:** Print or return structured resolution metadata: `query`, `resolved_name`, `country`, `region`, `id`, `scope`, etc. This generalizes beyond maps to cloud accounts, Kubernetes contexts, repository selection, time windows, and ID prefixes.

## 8. Emit progress or estimates for expensive routes

**Statement:** Long-running commands should not look like hangs; they should emit progress, scope, or cheaper alternatives.

**Evidence / failure class:** Class D = 3 degenerate routes. `docs/plan.md` also records long silent operations being interpreted as hangs.

**Confidence:** Hypothesis; low current signal and likely confounded by runtime variance.

**Design implication:** For expensive commands, provide `--estimate`, progress on stderr, recommended narrower filters, and clear completion states.

---

# 3. Evaluator and instrumentation principles learned

## 9. Treat silent wrong as first-class

**Statement:** A successful exit can still be a severe CLI failure if it silently misleads the agent.

**Evidence / failure class:** Class C = 55 in the corrected baseline. This was the central measurement improvement: silent wrong outcomes became visible instead of being counted as clean.

**Confidence:** Confirmed as an evaluator principle.

**Design implication:** Evaluation must inspect output semantics, not just exit code. Differential probes should test whether a zero or capped output survives relevant changes.

## 10. Score recoverability separately

**Statement:** An agent-friendly CLI is not one that never errors; it is one that lets the agent recover unaided.

**Evidence / failure class:** New scoring weights correctness/recoverability at 60%, including self-recovery and guidance quality. Class B guided failures are low-penalty; class A and C are costly.

**Confidence:** Provisional evaluator principle; needs more paired self-recovery runs.

**Design implication:** Track self-recovery rate, extra calls, tokens, and wall-clock after first recoverable failure.

## 11. Separate tool blame from environment and agent-side behavior

**Statement:** Quota/network failures and ignored hints should be recorded but not charged to the CLI.

**Evidence / failure class:** Record-v2 supports attempt-level E for quota/environment failures. F is agent-side and recorded separately. Clean calls serialize as JSON `"class": null`.

**Confidence:** Confirmed as instrumentation design.

**Design implication:** Use explicit axes: outcome, blame, recovery. Derive class from axes; do not hand-store contradictory classes.

## 12. Probe evidence must be auditable and sabotage-tested

**Statement:** An evaluator for invisible failures must show its work and be validated against known false negatives and false positives.

**Evidence / failure class:** The MA/MT correction showed evaluator false findings are a first-class risk. `c-unknown` = 25 shows that inconclusive probes should remain visible, not become “clean.”

**Confidence:** Confirmed as instrumentation principle.

**Design implication:** Every classified failure should include probe kind, command run, result, conclusive flag, and evidence. Maintain sabotage fixtures for each class and subtype.

---

# 4. Anti-patterns: what makes a CLI hostile to agents

## A. Silent caps

Returning the first N results without saying more exist causes agents to treat partial discovery as complete.

## B. Ambiguous zeroes

A bare `0` or empty list is hostile when it might mean wrong field, wrong type, wrong spelling, unsupported filter, or true absence.

## C. Raw usage as recovery

Dumping generic usage after a parse error often leaves the agent to guess. It should get a corrected local retry.

## D. Hidden defaults and resolutions

Implicit region, account, namespace, project, entity, or time range selection is dangerous when the agent cannot see what was chosen.

## E. Schema that is only human-legible

If valid fields and values are buried in prose docs, agents resort to broad listing and grep. Discovery needs to be executable.

## F. Advice that is not executable

A hint that does not include a working command, or recommends an expensive/noisy path, is not useful guidance.

## G. Treating evaluator uncertainty as cleanliness

`c-unknown` is instrumentation debt, not proof that the CLI behaved well.

## H. Optimizing by changing the judge

The evaluator must be held separate from candidate CLI changes. Otherwise score movement stops answering the research question.

---

# 5. What a CLI author should do differently tomorrow

1. **Add completeness metadata to every bounded listing.** Show `shown`, `total`, `truncated`, and exact continuation or larger-limit command.

2. **Add zero-result diagnostics.** For empty results, validate fields, values, resource types, and common aliases before letting the user conclude absence.

3. **Return exact retry commands in errors and warnings.** Use stable phrasing such as `Try: <command>`; keep JSON stdout valid and put guidance in stderr or structured diagnostics.

4. **Make schema discovery executable.** Provide `schema`, `fields`, `values`, `search`, and `explain-filter` commands rather than relying on prose help alone.

5. **Echo interpretation.** Show resolved entity/scope/defaults: selected account, region, namespace, repo, time range, place, resource type, or ID expansion.

6. **Prefer high-confidence hints over broad suggestions.** Exact field/value/type matches are useful; vague “did you mean” noise can mislead.

7. **Design for shell composition.** Preserve machine-readable stdout; emit human/agent guidance on stderr or in explicit diagnostic fields.

8. **Measure recovery, not just success.** Track whether agents used hints, how many commands they burned, and whether final answers changed.

---

# Top-level conclusion

The current evidence supports two concrete botmap-confirmed principles: do not silently truncate, and when a value exists in another field, say where. The broader general framework is that agent-friendly CLIs must expose hidden state: completeness, interpretation, schema compatibility, and recovery actions. The next research step is replication on another structured CLI, such as a traces/logs CLI, to distinguish botmap-specific findings from general CLI design laws.
