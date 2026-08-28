# General principles: what makes a CLI agent-friendly?

Synthesis from the autoresearch/botmap experiments so far. This is not final doctrine; it separates paired evidence from hypotheses and evaluator lessons.

Primary evidence:

- `docs/agent-friendly-cli.md`
- `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`
- `experiments/paired/categories-truncation-hint/result.md`
- `experiments/paired/count-wrong-column-hint/result.md`
- `experiments/arm-d/PLAN.md`

Baseline measurement, corrected after the MA/MT entity-probe repair:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {
    "c-truncated": 25,
    "c-unknown": 25,
    "c-wrong-type": 3,
    "c-wrong-column": 2
  }
}
```

## 1. Principles supported by paired evidence

### 1. Never silently truncate output

- **Statement:** If output is capped, the CLI must say it is capped and name the exact recovery action.
- **Evidence / failure class:** `c-truncated`. In the paired categories experiment, truncation failures fell from **13 to 5** on the matched subset after `botmap categories --top N` emitted a stderr warning: rerun with `--top TOTAL` or a larger `--top` before concluding a category is absent.
- **Confidence:** confirmed, provisionally.
- **Design implication:** Treat limits as part of the protocol. Preserve stable stdout for data, but use stderr or metadata to say: how many items were shown, how many exist, and what command recovers the full set.

### 2. If a value exists elsewhere, say where

- **Statement:** If a filter returns zero but the value exists in a sibling field, the CLI should name the correct field and provide the corrected filter.
- **Evidence / failure class:** `c-wrong-column`. In the paired count experiment, wrong-column failures fell from **2 to 0** on the matched subset after `botmap count` emitted hints such as: `0 rows for subtype='bicycle_parking', but class='bicycle_parking' returns 1,844. Try --where class=bicycle_parking...`.
- **Confidence:** confirmed, narrowly.
- **Design implication:** Empty results should trigger cheap local diagnostics before the CLI lets the agent believe “none exist.” For structured data, check nearby schema locations and give a concrete retry command.

### 3. Stable stdout plus actionable stderr is a useful agent protocol

- **Statement:** Machine-readable stdout should stay parseable; recovery guidance can go to stderr without breaking JSON pipelines.
- **Evidence / failure class:** Both paired tool changes used stderr guidance while preserving JSON stdout. The measured target failures dropped for both truncation and wrong-column cases.
- **Confidence:** provisional; supported by two paired interventions, but not yet isolated as an independent variable.
- **Design implication:** Do not choose between clean data output and agent guidance. Keep stdout stable and use stderr, warnings, or side-channel metadata for explanations and next actions.

### 4. Agent-friendly CLIs teach recovery, not just syntax

- **Statement:** A useful diagnostic names the next action, not merely the problem.
- **Evidence / failure class:** The confirmed changes worked by adding recovery instructions: “rerun with larger `--top`” and “try `--where class=...`.” These convert silent wrongness into recoverable guidance.
- **Confidence:** provisional; inferred across paired results.
- **Design implication:** Error and warning text should include an executable or near-executable retry, not only a description.

## 2. Principles suggested by baseline traces but not yet experimentally confirmed

### 5. Never return an ambiguous zero without diagnostics

- **Statement:** A zero result should distinguish true absence from wrong field, wrong type, unsupported vocabulary, canonicalization mismatch, or unresolved ambiguity.
- **Evidence / failure class:** Baseline had **55 class C silent-wrong calls**, including **25 `c-unknown`**. `c-unknown` means an empty result occurred and probes could not yet explain why.
- **Confidence:** hypothesis.
- **Design implication:** Add zero-result diagnostics carefully: first improve probes enough to avoid false hints, then test paired changes. A CLI should not let agents treat every zero as a fact.

### 6. If the same filter works under another type, say the type

- **Statement:** When a filter is valid but queried against the wrong feature type, the CLI should name the type where it returns rows.
- **Evidence / failure class:** Baseline had **3 `c-wrong-type`** calls. Arm D identifies ready examples such as `class=beach` under `land_use`/`water` where `land` works, and `subtype=military` under `building` where `land_use` works.
- **Confidence:** hypothesis, high-priority.
- **Design implication:** For zero counts, run bounded sibling-type checks and emit: “0 rows for `-t X filter=Y`, but `-t Z filter=Y` returns N. Try ...”.

### 7. Convert raw failures into guided recoveries

- **Statement:** Common usage errors should become class B guided failures rather than class A dead ends.
- **Evidence / failure class:** Baseline had **38 class A** failures. Arm D notes many appear to be parser/usage failures, unsupported option placement, or possibly guided errors misclassified as A.
- **Confidence:** hypothesis; needs zero-spend triage before paid paired work.
- **Design implication:** Parser errors should include accepted syntax, location of the mistake, and a corrected command. But first audit whether the evaluator is already missing existing guidance.

### 8. Make discovery a first-class operation

- **Statement:** Agents should not have to infer vocabulary by dumping large lists, grepping, and guessing larger limits.
- **Evidence / failure class:** Baseline `c-truncated=25`; many failures involve category discovery. Arm D proposes `categories --search TERM` / value search as a broader experiment.
- **Confidence:** hypothesis.
- **Design implication:** Add targeted discovery commands for categories, fields, valid values, and near matches. Design them to be cheap, bounded, and easy for agents to discover from help text.

### 9. Confirm entity resolution

- **Statement:** When a command resolves a place or entity, it should echo what it resolved, including region/country, so agents can catch ambiguity.
- **Evidence / failure class:** Initial `c-wrong-entity` findings were evaluator false positives caused by MA/MT abbreviation handling. After repair, current Phase 4 has no valid `c-wrong-entity`, so existing evidence does not confirm the product problem.
- **Confidence:** hypothesis.
- **Design implication:** Likely valuable, but needs a deliberate ambiguous-location mini-bank and validated probes before making claims.

### 10. Emit progress or estimates for long operations

- **Statement:** Long-running operations should reassure the agent that the command is working and suggest cheaper alternatives when available.
- **Evidence / failure class:** Baseline had **3 class D** degenerate/route-quality failures, but signal is small and confounded with timeouts and command choice.
- **Confidence:** hypothesis.
- **Design implication:** Consider progress on stderr for known expensive operations, but improve D instrumentation before spending on broad experiments.

## 3. Evaluator and instrumentation principles learned

### 11. Build an evaluator that can see silent wrongness before optimizing

- **Statement:** If the evaluator only sees crashes, the optimizer will miss the most dangerous CLI failures.
- **Evidence / failure class:** New agenteval surfaced **55 class C** calls. Old shallow scoring risked treating confident wrong answers as acceptable.
- **Confidence:** confirmed as an experimental lesson.
- **Design implication:** Evaluate not only exit codes, but also empties, truncation, schema misuse, recovery guidance, and final answer plausibility where possible.

### 12. Treat failure taxonomy as a design-requirement generator

- **Statement:** Each failure subtype should map to a concrete CLI property.
- **Evidence / failure class:** `c-truncated` produced “never silently truncate”; `c-wrong-column` produced “if value exists elsewhere, say where”; `c-wrong-type` suggests type hints.
- **Confidence:** provisional.
- **Design implication:** Do not stop at labels. Every classified failure should answer: what should the CLI have said or exposed for the agent to recover?

### 13. Separate candidate evidence from confirmed evidence

- **Statement:** A probe can show the CLI had hidden information; only a paired run shows whether surfacing it helped the agent.
- **Evidence / failure class:** The project uses Tier 1 for differential probe candidates and Tier 2 for paired before/after confirmation. Two properties have Tier 2 evidence so far.
- **Confidence:** confirmed as methodology.
- **Design implication:** Phrase claims carefully: “candidate” for probe-only, “confirmed narrowly/provisionally” for paired subset success, and reserve general claims for held-out/full-bank replication.

### 14. Keep evaluator bugs visible and correctable

- **Statement:** Evaluator bugs can manufacture fake product insights.
- **Evidence / failure class:** The initial `c-wrong-entity` bucket was an instrument bug: MA and MT were treated as ISO-country-like codes before recognizing valid US state abbreviations. The histogram was corrected after repair.
- **Confidence:** confirmed.
- **Design implication:** Record probe evidence, keep artifacts auditable, maintain sabotage fixtures, and publicly revise findings when the evaluator is wrong.

### 15. Do not let optimizers edit the exam

- **Statement:** Broad optimization must keep evaluator and fixture files read-only, or it can overfit by changing the yardstick.
- **Evidence / failure class:** Arm C guardrail excludes evaluator/yardstick files from the editable set; Arm D repeats that evaluator files are read-only during tool-candidate work unless explicitly doing evaluator work.
- **Confidence:** confirmed as a guardrail, not a measured CLI property.
- **Design implication:** Separate product surface, prompt/instruction surface, and evaluator surface. Track which lever changed in every experiment.

### 16. Attribute failures before scoring them

- **Statement:** Environment and agent-side failures should be recorded without charging them to the CLI.
- **Evidence / failure class:** Taxonomy separates E environment/quota and F agent-side failures. Baseline currently has empty `agent_side_counts`, but the distinction is part of the scoring contract.
- **Confidence:** provisional methodology.
- **Design implication:** Avoid optimizing the CLI to fix quota, network, or agent stubbornness. Record bypasses and ignored hints separately.

## 4. Anti-patterns: what makes a CLI hostile to agents

### 17. Silent truncation

- **Statement:** Returning exactly N items without saying more exist invites agents to conclude the missing item does not exist.
- **Evidence / failure class:** `c-truncated=25` baseline; paired reduction 13 → 5 after warning.
- **Confidence:** confirmed.
- **Design implication:** Always disclose caps and recovery commands.

### 18. Polite wrong zeroes

- **Statement:** Exit 0 plus `0` rows plus no explanation is often worse than an error.
- **Evidence / failure class:** Class C silent wrong was common: **55 calls** baseline.
- **Confidence:** provisional overall; confirmed for wrong-column and truncation subcases.
- **Design implication:** Empty outputs need diagnostics or explicit “true zero confidence” context.

### 19. Ontology opacity

- **Statement:** Agents struggle when field names, type names, category vocabularies, and canonical values are discoverable only by trial and error.
- **Evidence / failure class:** `c-wrong-column`, `c-wrong-type`, `c-truncated`, and `c-unknown` all point to ontology-discovery friction.
- **Confidence:** provisional.
- **Design implication:** Provide schema/value discovery and near-match search as first-class commands.

### 20. Non-actionable errors

- **Statement:** Errors that say only “invalid” or expose raw parser behavior leave agents to repeat variants blindly.
- **Evidence / failure class:** Class A baseline count **38**; Arm D identifies usage-error clusters needing triage.
- **Confidence:** hypothesis.
- **Design implication:** Include exact accepted syntax and corrected command examples.

### 21. Breaking machine-readable output with human prose

- **Statement:** Mixing warnings into JSON stdout can make a CLI less agent-friendly even if the warning is useful.
- **Evidence / failure class:** Confirmed candidates deliberately preserved JSON stdout and used stderr.
- **Confidence:** provisional.
- **Design implication:** Keep data and guidance channels separate.

### 22. Hidden resolution choices

- **Statement:** Silently choosing an entity, region, type, or canonical value forces agents to trust assumptions they cannot inspect.
- **Evidence / failure class:** Entity issue is not confirmed after MA/MT repair; wrong-column/type evidence supports the broader opacity concern.
- **Confidence:** hypothesis.
- **Design implication:** Echo resolved entities and normalized filters where ambiguity matters.

## 5. What a CLI author should do differently tomorrow

1. **Add truncation notices everywhere.** If a command limits output, print “showing N of TOTAL” and a precise retry command. Keep stdout stable; put guidance on stderr or structured metadata.
2. **Add zero-result diagnostics for structured filters.** For zero counts, check sibling fields and types when cheap. Say where the value exists and provide the corrected command.
3. **Design every error as a recovery step.** Include the invalid part, accepted alternatives, and an exact retry. Treat guided errors as successful interface behavior, not embarrassment.
4. **Expose ontology deliberately.** Add commands for schema, valid values, category search, near matches, and examples that use the same syntax agents should use.
5. **Make output self-describing but parse-safe.** Echo resolved entities, normalized filters, limits, and assumptions without corrupting machine-readable stdout.
6. **Instrument before optimizing.** Track silent wrongs, recoverability, token/call cost, wall-clock, environment failures, and agent-side ignored hints.
7. **Validate the evaluator.** Use sabotage fixtures and audit probe evidence. Assume evaluator bugs can create fake product insights until disproven.
8. **Use paired runs for claims.** Same question, same conditions, one change, measured before/after delta. Use held-out or full-bank replication before claiming generality.

## Top-line answer

A CLI becomes agent-friendly when it makes wrong turns observable and recoverable. The strongest evidence so far is not that agents need more features; it is that agents need CLIs to surface hidden state: limits, schema, valid fields, valid types, and exact next actions. Crashes are visible. Silent wrongness is the real enemy.
