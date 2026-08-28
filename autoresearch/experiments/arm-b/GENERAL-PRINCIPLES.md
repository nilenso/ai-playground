# General principles for agent-friendly CLIs — Arm B synthesis

This synthesis answers the core research question from the autoresearch/botmap work so far: **what makes a CLI agent-friendly?** It separates paired evidence from trace-derived hypotheses and evaluator lessons. Confidence levels mean:

- **confirmed** — paired BEFORE/AFTER evidence showed improvement under matched conditions.
- **provisional** — measured evidence points in a direction, but sample size, enrichment, or confounders limit the claim.
- **hypothesis** — baseline traces or optimizer behaviour suggest the principle, but no paired experiment has confirmed it.

## 1. Principles supported by paired evidence

### 1.1 Say when output is truncated

**Statement**  
An agent-friendly CLI must explicitly say when a list has hit a limit, and must name the recovery action.

**Evidence / failure class**  
Failure class: `c-truncated`. In Phase 4, agents treated capped `categories --top N` output as complete. Differential probes with a larger `--top` found more rows. In the paired `categories` truncation experiment, adding this stderr hint:

```text
[botmap] Showing top N of TOTAL categories. This list is truncated; rerun with
`--top TOTAL` or a larger --top before concluding a category is absent.
```

reduced `c-truncated` on the matched subset from **13 to 5**:

```text
BEFORE: experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
AFTER:  experiments/runs/after-categories-truncation-hint-00bff1a/agenteval-summary.json
```

**Confidence**  
confirmed, provisionally. The direction is strong, but the subset was three questions × two repeats and one AFTER attempt still timed out.

**Design implication**  
Any CLI command that returns a bounded list should include machine-visible metadata or stderr/stdout guidance such as `showing N of TOTAL`, `truncated: true`, and `rerun with --limit TOTAL`. Do not rely on agents inferring truncation from exactly-N rows.

### 1.2 If a value exists elsewhere, say where

**Statement**  
If the user supplied a real value in the wrong field/column, an agent-friendly CLI should say which field contains that value and give the corrected filter.

**Evidence / failure class**  
Failure class: `c-wrong-column`. Agents used values such as `bicycle_parking` or `recreation` in the wrong field, got zero, and treated the zero as absence. In the paired `count` wrong-column experiment, adding a diagnostic that tests the paired field and emits a concrete correction reduced `c-wrong-column` from **2 to 0** on the matched subset:

```text
[botmap] 0 rows for subtype='bicycle_parking', but class='bicycle_parking'
returns 1,844. Try `--where class=bicycle_parking` before concluding none exist.
```

Sources:

```text
BEFORE: experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
AFTER:  experiments/runs/after-count-wrong-column-hint-7c794ff/agenteval-summary.json
```

**Confidence**  
confirmed narrowly. The property is confirmed for the observed wrong-column failures, not for all task success.

**Design implication**  
When a filtered count/list returns zero, the CLI should cheaply check adjacent schema fields for the same value and return: “you asked `field=A`, but `other_field=A` has rows; try this exact command.” This is better than a generic schema dump.

### 1.3 Name the recovery command, not just the problem

**Statement**  
Agent-friendly guidance is concrete: it names the next command or argument the agent should try, not merely the cause.

**Evidence / failure class**  
Failure class relation: Class B (`error` + `guided`) is much less damaging than Class A (`error` + `unguided`) or Class C (`empty` + `unguided`). Both paired successful tool changes worked by adding explicit recovery text: `rerun with --top ...` and `try --where class=...`. The evaluator rubric also scored guided recoveries better than silent wrongs.

**Confidence**  
provisional/confirmed as a mechanism inside the two confirmed experiments. It is not yet independently tested across all error classes.

**Design implication**  
Error messages and suspicious-zero diagnostics should include copy-pasteable commands or exact flag/value replacements. A CLI should optimize for the agent’s next step, not for human-style explanation alone.

## 2. Principles suggested by baseline traces, not yet experimentally confirmed

### 2.1 Never return an unexplained zero

**Statement**  
A successful command returning zero rows is ambiguous. If zero could mean “wrong type,” “wrong field,” “wrong value,” “wrong area,” or true absence, the CLI should say what it checked and what remains unknown.

**Evidence / failure class**  
Failure class: Class C, especially `c-unknown`. Phase 4 combined histogram:

```json
{"records":60,"attempts_with_failures":34,"class_counts":{"clean":389,"C":55,"B":15,"A":38,"D":3},"subtype_counts":{"c-truncated":25,"c-unknown":25,"c-wrong-type":3,"c-wrong-column":2}}
```

Class C silent wrong failures were the largest charged class. `c-unknown=25` means the evaluator could not yet explain many empty outputs, not that the CLI was correct.

**Confidence**  
hypothesis with strong baseline evidence.

**Design implication**  
For zero-result `count` and list commands, emit a structured diagnostic: unfiltered count in same area, whether the value exists in the taxonomy, whether it exists in sibling fields/types, and whether the area resolution was suspect. If that is too expensive by default, provide a `--diagnose-zero` or `--explain-empty` mode and advertise it on zero.

### 2.2 Say when the same value exists under another type or verb

**Statement**  
If a concept lives under a different feature type, the CLI should name that type and the retry command.

**Evidence / failure class**  
Failure class: `c-wrong-type`. Phase 4 found `c-wrong-type=3`. Arm D’s plan identifies examples such as beach data under `land` rather than `land_use`, and residential/military cases where the same intent lives under another type.

**Confidence**  
hypothesis, ready for paired testing.

**Design implication**  
Commands should not assume the agent knows the data model. When `-t land_use --where class=beach` returns zero but `-t land class=beach` has rows, return “this is a `land` feature; try ...”. The type graph should be discoverable from failures.

### 2.3 Advertise only values that work

**Statement**  
Help text, examples, and skill files are part of the CLI. If they advertise a value under a flag, that value should work with that flag.

**Evidence / failure class**  
Failure class: `c-wrong-column` / `c-vocabulary`. Existing findings showed `landuse --class recreation` returned zero while `subtype=recreation` returned rows; `roads --class sidewalk` similarly mapped to a wrong level. Arm B prompt candidates sometimes repeated false or stale vocabulary, showing that documentation defects propagate into agent behaviour.

**Confidence**  
hypothesis with Tier 1 differential evidence; partially supported by the confirmed wrong-column experiment.

**Design implication**  
Generate examples and value lists from the same schema/data source used by the CLI. Add tests that every value shown in `--help`, docs, and skill files returns non-empty somewhere or is clearly labelled as an example of a field, not a guaranteed local result.

### 2.4 Confirm what entity was resolved

**Statement**  
A CLI that resolves names should show the resolved entity, including type, country/region, and ambiguity/fallback information, in a place the agent will see.

**Evidence / failure class**  
Potential failure class: `c-wrong-entity`. Prior traces included wrong-place risks such as `Malta, MT` and diacritic/non-local spelling issues. However, the Phase 4 `c-wrong-entity` bucket was repaired away as an evaluator bug: the probe initially confused US state abbreviations such as `MA`/`MT` with ISO country codes.

**Confidence**  
hypothesis. Existing baseline after repair has no valid `c-wrong-entity`; a deliberate ambiguous-location mini-bank is needed.

**Design implication**  
`where` and any command accepting `--in` should echo the resolved `{name, subtype, country, region, bbox}`. If a fallback or ambiguous candidate was used, say so and show how to disambiguate.

### 2.5 Make discovery first-class

**Statement**  
Agents should not have to guess values by requesting huge lists and grepping. Discovery should be a direct operation.

**Evidence / failure class**  
Related failures: `c-truncated`, `c-unknown`, high command counts. Phase 4 saw many `categories --top N` truncation failures, and Arm D identifies discovery as broad but confounded. Agents burned commands discovering category slugs, sometimes concluding absence from truncated lists.

**Confidence**  
hypothesis, with confirmed evidence that the current list-style discovery truncates badly.

**Design implication**  
Add commands like `categories --search TERM`, `values --type TYPE --field FIELD --search TERM`, or schema-aware suggestions on zero. Search results should be ranked, bounded, and explicit about field/type.

### 2.6 Emit progress or cost estimates for long operations

**Statement**  
Long-running commands should emit progress, estimated size, or phase changes so an agent does not read silence as a hang.

**Evidence / failure class**  
Failure class: D (`degenerate`). Phase 4 found `D=3`, tied to long/expensive routes such as boundary geometry or containing queries. Earlier notes mention agents abandoning correct commands after many minutes of silence.

**Confidence**  
hypothesis; current D bucket is small and confounded with cache/network/model time.

**Design implication**  
For commands expected to take more than a few seconds, print progress to stderr or expose `--estimate`. Include “still working” heartbeats for large downloads/geometries.

### 2.7 Provide first-class composition for common spatial questions

**Statement**  
If users often ask “X near Y” or “X within N metres of Y,” an agent-friendly CLI should provide a direct command rather than forcing local GIS scripting.

**Evidence / failure class**  
Arm B’s prompt optimizer repeatedly asked for `botmap/nearby.py`, a first-class spatial join command, even though it was only allowed to edit the skill file. This came from the optimizer trying to explain tasks like buildings near water or bike parking near bike paths.

**Confidence**  
hypothesis from optimizer behaviour and trace inspection, not paired evidence.

**Design implication**  
Add compositional operations for common multi-layer tasks, or at least emit recipes with bounded samples and safe local joins. Do not make agents synthesize shapely pipelines from scratch for routine questions.

### 2.8 Instructions help, but long manuals are not enough

**Statement**  
Prompt-side guidance can encode recovery procedures, but a longer instruction file does not necessarily make the CLI more agent-friendly.

**Evidence / failure class**  
Arm B prompt-lever GEPA run:

```text
Run: experiments/runs/prompt-3009509-1787544952/
Base valset score: 0.7171183364842026
Candidate valset scores: 0.6158909004401625, 0.4947683096963408, 0.5220595289553529, 0.6955642283862925
Best program: base
files_changed: []
```

Candidates looked subjectively safer and added protocols for zero results, place names, quoting, transit, brands, and spatial joins, but none beat the base on held-out score.

**Confidence**  
provisional negative result for open-ended prompt GEPA, not proof that all prompt changes fail.

**Design implication**  
Prefer compact, property-indexed guidance and tool-emitted diagnostics over encyclopedic skill files. Test prompt changes with paired subsets rather than assuming more instructions improve behaviour.

## 3. Evaluator and instrumentation principles learned

### 3.1 Score recovery and observability, not just final success

**Statement**  
An evaluator for agent-friendly CLIs must distinguish correct answers, self-recovery, guidance quality, route quality, and failure attribution.

**Evidence / failure class**  
The new rubric splits correctness/recoverability into final outcome, self-recovery, guidance/error quality, route quality, and attribution. This exposed failures old scoring hid, especially Class C silent wrong outputs.

**Confidence**  
provisional but strongly supported by the measurement distribution.

**Design implication**  
CLI evaluations should store transcripts, calls, stdout/stderr heads, durations, tool counts, recovery details, and final answer text. A scalar score alone is not enough.

### 3.2 Treat silent wrong as worse than honest refusal

**Statement**  
A CLI that crashes or refuses with an error is often less hostile to agents than one that succeeds with an unexplained wrong zero.

**Evidence / failure class**  
Class C (`empty` + `unguided`) was given the heaviest penalty. Phase 4 found `C=55`; many earlier “perfect” old-scorer attempts were suspect because Class C was invisible.

**Confidence**  
provisional as evaluator design; supported by traces where agents confidently reported absence after zeros.

**Design implication**  
Prefer explicit refusal or warning over silent success when semantics are suspect. Exit 0 is not inherently agent-friendly if it hides ambiguity.

### 3.3 Use differential probes, and record their evidence

**Statement**  
To diagnose agent failures, run cheap post-hoc CLI probes outside the agent transcript and save what they found.

**Evidence / failure class**  
The evaluator’s probes identified `c-truncated`, `c-wrong-column`, and `c-wrong-type` candidates. The two confirmed paired experiments came directly from probe evidence: “raising the limit finds more rows” and “paired field has rows.”

**Confidence**  
confirmed as an instrumentation method for finding candidate properties; not every probe is perfect.

**Design implication**  
Build evaluator probes that ask: did the value exist elsewhere, did a higher limit reveal data, did another type work, did repeated flags get dropped, did the entity resolve as intended? Store `ran`, `result`, and `conclusive` fields for auditability.

### 3.4 Validate the evaluator with sabotage fixtures

**Statement**  
If the target failure is invisible by definition, the evaluator must include fixtures that force the detector to fire.

**Evidence / failure class**  
The project added sabotage fixtures for classes A-F and class-C subtypes before allowing measurement. The MA/MT entity false positive demonstrates why this matters: probes themselves can create false findings.

**Confidence**  
provisional/confirmed as a necessary practice from observed evaluator bug.

**Design implication**  
Treat evaluator code like experimental apparatus. Add known-bad fixtures, repair procedures for derived records, and never rewrite raw attempts in place.

### 3.5 Record bypasses and environment separately

**Statement**  
An agent using web search, hitting quota, or encountering network failures is evidence about the run, but not necessarily a CLI defect.

**Evidence / failure class**  
The contract records tools used, botmap calls, and attempt-level Class E for quota/environment failures. Prior runs showed web search could answer a question with zero botmap calls, and quota/session-limit failures looked like candidate failures under old scoring.

**Confidence**  
provisional, strongly supported by run confounders.

**Design implication**  
Separate tool failures from agent failures and environment failures. Do not optimize a CLI based on quota exhaustion, DNS failures, or an agent routing around the tool without recording that bypass.

## 4. Anti-patterns: what makes a CLI hostile to agents

1. **Silent truncation** — returning exactly N rows without saying more exist.
2. **Silent zeros** — returning success/zero without diagnostic context.
3. **Wrong-field vocabulary** — documenting values under flags/columns where they do not work.
4. **Unstructured or generic errors** — errors that say “invalid” without a replacement command.
5. **Invisible place resolution** — accepting `--in` but not showing which entity/bbox was used.
6. **Ambiguous discovery surfaces** — requiring agents to guess `--top`, grep huge lists, or infer schema from examples.
7. **Silent input dropping** — accepting repeated/conflicting flags while using only one.
8. **Long silence** — commands that take minutes without progress or size estimates.
9. **Docs as stale interface** — help text and skill files that disagree with the executable schema.
10. **Infrastructure confounded with product behaviour** — quota/network/provider failures that look like tool failures.

## 5. What a CLI author should do differently tomorrow

1. **Add truncation metadata everywhere.** Every bounded list should say `returned`, `total`, and `truncated`, plus the exact rerun command.
2. **Make zero explainable.** For count/list commands, add a diagnostic path for zero results: unfiltered count, value existence, sibling field/type checks, and resolved area echo.
3. **Emit copy-paste recovery hints.** Convert common Class A and Class C cases into guided Class B-style outputs with exact flag/value replacements.
4. **Generate docs/help from schema.** Do not hand-maintain examples of valid values. Test every advertised value/flag pair.
5. **Echo resolved entities.** For any `--in`/name lookup, show name, type, country/region, bbox, fallback, and ambiguity in JSON and/or stderr.
6. **Add targeted discovery commands.** Prefer `--search`/`values`/`schema` workflows over requiring agents to enumerate and grep large lists.
7. **Reject or warn on repeated/conflicting inputs.** If multiple flags are not supported, fail loudly; if they are supported, echo all parsed filters.
8. **Show progress for expensive operations.** Print phases and estimates for geometry, large downloads, and cache/network-heavy operations.
9. **Measure with retained traces.** Save command logs, transcripts, record-v2 style verdicts, and probe evidence so claims can be audited.
10. **Run small paired experiments.** Do not infer agent-friendliness from subjective prompt quality or a single aggregate score; compare matched BEFORE/AFTER traces by failure class.

## Bottom line

The strongest supported answer so far is: **a CLI becomes agent-friendly when it makes hidden state and recovery paths explicit at the moment the agent needs them.** Agents are vulnerable to outputs that look successful but are semantically incomplete: capped lists, wrong-field zeros, wrong-type zeros, wrong-place resolutions, and long silence. The paired experiments show that small tool-side messages can reduce specific silent-wrong failures. Prompt-side instructions are useful but, in Arm B’s run, longer and more careful instructions did not beat the base prompt; the more robust design is to make the CLI itself observable, diagnostic, and next-action-oriented.
