# General principles: what makes a CLI agent-friendly?

This synthesis answers the core research question from the botmap/autoresearch evidence so far. It separates what paired experiments support from what baseline traces merely suggest. No new paid work was run for this synthesis.

## Evidence base

- Phase 4 measurement: `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`
- Confirmed paired experiments:
  - `experiments/paired/categories-truncation-hint/result.md`
  - `experiments/paired/count-wrong-column-hint/result.md`
- Arm D provisional wrong-type run:
  - plan: `experiments/arm-d/PLAN.md`
  - insight memo: `experiments/arm-d/INSIGHTS.md`
  - run dir: `experiments/runs/after-wrong-type-hint-tool-9ba1187/`
- Living synthesis doc: `docs/agent-friendly-cli.md`

Phase 4 baseline distribution after the MA/MT entity-probe repair:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2}
}
```

## 1. Principles supported by paired evidence

### 1. Never silently truncate output

- **Statement:** If a command returns a limited list, the CLI must say the list is incomplete and name how to get the complete list before an agent treats absence from the list as evidence of non-existence.
- **Evidence / failure class:** `c-truncated`. In Phase 4, `categories --top N` often returned exactly `N` rows with no notice. The agent read the capped list as complete. Differential probes with larger `--top` revealed more rows.
- **Paired result:** On `bike-parking-coverage`, `basic-category-rollup`, `bus-stops-cambridge` ×2, adding a tool-side truncation notice moved `c-truncated` **13 → 5**. Run: `experiments/runs/after-categories-truncation-hint-00bff1a/`. Cost/status: 6/6 attempts run, 5 completed, $1.3693.
- **Confidence:** **confirmed, provisional**. Strong direction on matched subset; not yet full-bank and one AFTER attempt timed out.
- **Design implication:** Any CLI flag like `--top`, `--limit`, `-n`, pagination, sampling, or default cap should emit machine-visible metadata: `returned`, `total_available` if known, `truncated: true`, and an exact rerun command. Human-friendly stderr is useful, but JSON should carry the same fact.

### 2. If a value exists elsewhere, say where

- **Statement:** If a filter value is valid but used in the wrong field, the CLI should identify the field where it exists and give the corrected filter.
- **Evidence / failure class:** `c-wrong-column`. Agents used values like `bicycle_parking` or `government` in `subtype` when rows existed under `class`, got zero, and treated zero as absence.
- **Paired result:** On `bike-parking-coverage`, `residential-share-cambridge` ×2, adding a tool-side wrong-column hint moved `c-wrong-column` **2 → 0**. Run: `experiments/runs/after-count-wrong-column-hint-7c794ff/`. Cost/status: 4/4 attempts run, 3 completed, $0.7439.
- **Confidence:** **confirmed narrowly**. It confirms the column guidance property, not broad task success.
- **Design implication:** For schema-rich CLIs, validation should not stop at “field exists” and counting should not return a bare zero when the same value is known in a sibling field. The CLI should perform cheap failure-path checks and say: “0 for `subtype=X`, but `class=X` returns N; try `--where class=X`.”

### 3. Name the exact recovery action, not just the problem

- **Statement:** Agent-friendly guidance is concrete and executable. The CLI should supply the next command or corrected argument, not merely a diagnosis.
- **Evidence / failure class:** Supported indirectly by both paired experiments. Truncation hint included “rerun with `--top TOTAL` or larger.” Wrong-column hint included the corrected `--where` expression. Both reduced their target silent-wrong subtype.
- **Paired result:** The two confirmed tool-side hints both combined diagnosis with a recovery action and both improved target subtype counts.
- **Confidence:** **confirmed as a cross-cutting pattern, but not isolated**. The experiments did not separately test “diagnosis-only” vs “diagnosis plus exact command.”
- **Design implication:** Error and warning messages should be designed as agent actions. Prefer “Try `botmap --json count -t infrastructure --where class=bicycle_parking`” over “wrong field” or “no results.”

## 2. Principles suggested by baseline traces but not yet experimentally confirmed

### 4. A bare zero is unsafe

- **Statement:** A zero result should carry a falsifiable explanation or a safe next probe. It should not force the agent to infer whether the zero means true absence, wrong vocabulary, wrong field, wrong type, wrong entity, or unsupported filter.
- **Evidence / failure class:** `C` dominated the baseline silent-wrong failures: 55 class-C calls, with `c-unknown=25`, `c-truncated=25`, `c-wrong-type=3`, `c-wrong-column=2`. The remaining `c-unknown` bucket is especially important: it means the evaluator could not explain the zero, not that the CLI behaved well.
- **Confidence:** **hypothesis with strong baseline support**. Two zero-related subtypes have paired support (`c-truncated`, `c-wrong-column`), and Arm D has provisional support for `c-wrong-type`, but zero-result diagnostics as a general property has not been fully tested.
- **Design implication:** Count/search commands should distinguish at least: true zero, invalid/unknown value, value in another field, value under another type, malformed/unsupported field, and query too narrow. If the CLI cannot know, it should say what safe diagnostic command to run next.

### 5. If data lives under another type, name that route

- **Statement:** If the same filter has rows under another feature type or verb, the CLI should say so and give the corrected type/verb.
- **Evidence / failure class:** `c-wrong-type`. BEFORE subset had 3 wrong-type failures: `class=beach` under `land_use`/`water` while `land` returned 65, and `subtype=military` under `building` while `land_use` returned 1.
- **Arm D result:** Candidate commit `9ba1187` in `/Users/priyangapkini/workspace/ar-d/botmap-wrong-type-hint` produced AFTER `c-wrong-type` **3 → 0** on `beach-accessibility-malta`, `residential-share-cambridge` ×2. Run dir: `experiments/runs/after-wrong-type-hint-tool-9ba1187/`.
- **Confidence:** **provisional**. Only 2/4 AFTER attempts completed; final answer correctness and full-bank generality were not proven. Candidate may add expensive alternate-type scans on zero results.
- **Design implication:** CLIs over typed data should expose ontology boundaries. If users ask `-t land_use class=beach` and `-t land class=beach` works, the tool should say exactly that. The check should be bounded and schema-aware to avoid making true-zero results slow.

### 6. Make discovery a first-class operation

- **Statement:** Agents should not have to guess category names by enumerating capped lists, grepping huge outputs, or trying synonyms blindly. Discovery should be an explicit command.
- **Evidence / failure class:** Baseline traces show repeated `categories --top N` calls, many `c-truncated` failures, and `c-unknown` vocabulary-like zeros such as `bus_stop`, `electric_vehicle_charging_station`, `charging_station`, and cuisine categories. The proposed `categories --search` experiment was not run.
- **Confidence:** **hypothesis**.
- **Design implication:** Add targeted discovery commands such as `categories --search TERM`, `values --field FIELD --search TERM`, or `schema --values FIELD`. Search output should include canonical values, counts, field/type, and exact filter examples.

### 7. Advertise only values that work in the advertised position

- **Statement:** Help/schema output should not list values in ways that imply they work with the wrong flag, field, or type.
- **Evidence / failure class:** `c-wrong-column`, `c-wrong-type`, and several `c-unknown` traces came from agents mapping plausible values to the wrong surface. This is closely related to wrong-column and wrong-type evidence, but no direct help/schema rewrite experiment has isolated it.
- **Confidence:** **hypothesis**.
- **Design implication:** Documentation and machine-readable capabilities should bind values to their usable context: type, field, verb, and example command. Avoid flat value lists without field/type provenance.

### 8. Confirm resolved entities

- **Statement:** When a CLI resolves a place name, especially an ambiguous one, it should echo the resolved entity with country/region/type in both JSON and human-readable output.
- **Evidence / failure class:** Originally suspected `c-wrong-entity`, but the MA/MT issue was an evaluator artifact: the probe treated US state abbreviations as ISO country codes before recognizing `US-MA`/`US-MT`. After repair, current Phase 4 has no valid `c-wrong-entity` bucket.
- **Confidence:** **hypothesis, not supported by current paired data**.
- **Design implication:** Still good design, but needs a deliberately ambiguous-location mini-bank before claiming. Echo `{name,country,region,subtype,bbox}` on `where` and on commands using `--in`.

### 9. Emit progress or estimates on long operations

- **Statement:** Long-running commands should show progress, bounded estimates, or cheaper alternatives so an agent can distinguish “working” from “hung.”
- **Evidence / failure class:** Baseline had `D=3` degenerate calls, including expensive geometry/containing routes. The progress experiment was not run, and D detection is currently too coarse.
- **Confidence:** **hypothesis**.
- **Design implication:** For commands that may scan large data or emit large geometry, print progress to stderr, estimate cost/rows early, and suggest cheaper commands (`bbox`, `count`, `sample`, summary mode) before full materialization.

### 10. Make obvious spellings and option placement work, or correct them

- **Statement:** If agents predict a reasonable spelling or option position, the CLI should accept it or produce a guided correction.
- **Evidence / failure class:** Baseline `A=38` included many usage/raw-error patterns: `at ... -t place --category ... --radius ... -n ...`, `--json` after subcommands, unsupported `--street` on `count`, and plural/snake-case command mismatches. The A→B recovery experiment was planned but not run by Arm D.
- **Confidence:** **hypothesis with strong baseline support**.
- **Design implication:** Use aliases, flexible global-option placement, and parser-level “did you mean / try this exact command” messages. Convert raw usage errors into class-B guided recoveries.

## 3. Evaluator and instrumentation principles learned

### 11. Separate failure severity from failure existence

- **Statement:** Not all failures should be scored equally. Honest guided refusals are very different from silent wrong answers.
- **Evidence / failure class:** The new taxonomy split failures into A-F. Class C silent wrongs are most damaging; class B guided recovery is near-free; class E environment failures are excluded; class F agent-side failures are recorded but not charged to the tool.
- **Confidence:** **confirmed as evaluator design**.
- **Design implication:** Evaluators for agent-facing tools should score correctness/recoverability separately from tokens and wall-clock, and should distinguish raw crash, guided refusal, silent wrong, degenerate route, environment failure, and agent non-use.

### 12. Differential probes turn traces into design requirements

- **Statement:** After an agent fails, cheap tool-only probes can reveal what the CLI could have said to prevent the failure.
- **Evidence / failure class:** Limit-raise probes found truncation; column-swap probes found wrong-column; type-sweep probes found wrong-type. These probes generated concrete candidate properties and paired experiments.
- **Confidence:** **confirmed as methodology**.
- **Design implication:** Build evaluation around “could the tool have known better?” Probes should be post-agent, budgeted, auditable, and excluded from the agent transcript.

### 13. Treat `c-unknown` as instrumentation work, not tool innocence

- **Statement:** If the evaluator cannot explain an empty result, the correct label is unknown, not clean.
- **Evidence / failure class:** Phase 4 had `c-unknown=25`, tied with `c-truncated` as the largest C subtype. Many are plausibly vocabulary/canonicalization/unsupported-field/true-zero cases, but current probes cannot split them reliably.
- **Confidence:** **confirmed as evaluator caution**.
- **Design implication:** Do not optimize or claim properties against `c-unknown` until probes can distinguish causes. Unknown buckets should drive probe improvement first.

### 14. Instrumentation bugs can create false product claims

- **Statement:** Evaluators need sabotage fixtures and repair mechanisms because instrumentation artifacts can masquerade as CLI failures.
- **Evidence / failure class:** The initial MA/MT entity-probe false positive created a `c-wrong-entity` bucket until repaired. The bug came from treating `MA`/`MT` as ISO country codes before valid US state abbreviations.
- **Confidence:** **confirmed**.
- **Design implication:** Every classifier/probe subtype needs fixtures. Broad claims require audited probe evidence, especially for ambiguity and entity resolution.

### 15. Evaluation infrastructure needs the same usability properties as the CLI

- **Statement:** Probe and enrichment systems also need bounded work, progress, and clear failure semantics.
- **Evidence / failure class:** Arm D’s first enrichment pass failed on a CLI-only truncation probe timeout; rerunning enrichment with a larger timeout completed. This was measurement fragility, not paid agent behavior.
- **Confidence:** **provisional but important**.
- **Design implication:** Probe runners need timeouts, skipped-probe records, and summaries that distinguish “agent failed” from “enrichment incomplete.”

## 4. Anti-patterns: what makes a CLI hostile to agents

### 16. Bare success with misleading absence

- **Statement:** Exit 0 plus `0`/empty output can be worse than an error if the agent treats it as truth.
- **Evidence / failure class:** Class C: 55 silent wrong calls in Phase 4.
- **Confidence:** **confirmed as an anti-pattern**.
- **Design implication:** Do not return bare zero for ambiguous query failures. Attach diagnostics or safe next probes.

### 17. Silent caps and defaults

- **Statement:** Silent limits make agents draw false negative conclusions.
- **Evidence / failure class:** `c-truncated=25`; paired truncation hint reduced the target subtype 13→5.
- **Confidence:** **confirmed**.
- **Design implication:** Every cap should be explicit in output and metadata.

### 18. Raw parser usage dumps

- **Statement:** Generic usage text without a corrected command leaves agents stuck or causes loops.
- **Evidence / failure class:** Many class-A baseline failures show `Usage: python -m botmap ...` for plausible commands.
- **Confidence:** **hypothesis for remediation, confirmed as observed failure mode**.
- **Design implication:** Parser errors should include “what I think you meant” and exact valid alternatives.

### 19. Flat or context-free taxonomies

- **Statement:** Lists of values without field/type provenance cause agents to put valid values in invalid places.
- **Evidence / failure class:** `c-wrong-column`, `c-wrong-type`, `c-unknown`.
- **Confidence:** **hypothesis, with paired support for two consequences**.
- **Design implication:** Always attach values to context: type, field, command, and example.

### 20. Long silence

- **Statement:** Long-running commands without progress look like hangs and waste agent budget.
- **Evidence / failure class:** D traces and timeouts; not yet paired.
- **Confidence:** **hypothesis**.
- **Design implication:** Emit progress/estimate or early warning for expensive routes.

## 5. What a CLI author should do differently tomorrow

1. **Add truncation metadata everywhere.** If output is capped, include `truncated: true`, returned count, known/estimated total, and an exact command to fetch more.
2. **Turn zero results into diagnostic events.** On zero, check cheap alternatives: sibling fields, known vocabulary, obvious type mismatch, unsupported fields, and canonical forms. If no explanation is safe, say “unexplained zero” and suggest a bounded discovery command.
3. **Write errors as recovery commands.** Every usage error should include a valid command the agent can run next. Make this available in JSON and stderr.
4. **Expose typed discovery.** Provide first-class commands to search schema values by term and return canonical value + field + type + count + example filter.
5. **Echo interpretation.** When the CLI resolves names, parses filters, applies defaults, caps output, or chooses a type/field, echo the interpreted state in machine-readable form.
6. **Prefer bounded failure-path checks over broad scans.** The wrong-type candidate is promising, but full-bank safety depends on bounding alternate-type probes and checking schemas before scanning.
7. **Design for agents without harming humans.** The best observed hints are also good human UX: they explain what happened, why the result may mislead, and exactly what to do next.

## Bottom line

The emerging answer is: **an agent-friendly CLI makes its interpretation and uncertainty observable, especially at the point where a normal CLI would return a terse success, empty result, or generic usage error.** Agents fail less when the tool turns hidden state into explicit, executable recovery guidance: “this list is truncated,” “that value belongs in another field,” “that filter works under another type,” and “run this exact command next.”

The strongest paired evidence supports truncation notices and wrong-column hints. The baseline strongly suggests broader zero diagnostics, typed discovery, parser recovery, entity echoing, and progress reporting, but those remain hypotheses until paired experiments confirm them.
