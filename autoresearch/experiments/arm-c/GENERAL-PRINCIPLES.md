# General principles for agent-friendly CLIs

This synthesis answers the core research question from the botmap/autoresearch experiments so far:

> What makes a CLI agent-friendly?

The short answer: an agent-friendly CLI makes its state, assumptions, limits, and recovery paths explicit enough that an agent can diagnose and recover without human intervention. The experiments so far suggest the decisive properties are less about adding data capability and more about observability, self-description, and executable repair advice.

## 1. Principles supported by paired evidence

### 1. Say when output is truncated

- **Statement:** If a command returns a bounded list, the CLI must say when the list hit a limit and must name the exact command/action to retrieve the full or safer result.
- **Evidence / failure class:** `c-truncated`. In the Phase 4 baseline, category listings often returned exactly `--top N` rows with no truncation notice. Agents treated the capped list as complete and concluded categories were absent. In the paired truncation experiment, adding a truncation warning to `categories --top N` reduced `c-truncated` from **13 to 5** on the matched subset (`bike-parking-coverage`, `basic-category-rollup`, `bus-stops-cambridge`, 2 repeats each). Source: `experiments/paired/categories-truncation-hint/result.md`.
- **Confidence:** **confirmed**, provisionally. The direction is strong, but the paired subset was small and one AFTER attempt timed out.
- **Design implication:** Never silently paginate, rank, sample, cap, or truncate. Emit a machine-visible note such as: “Showing N of TOTAL. This is truncated; rerun with `--top TOTAL` or larger `--top` before concluding absent.” For JSON modes, include structured fields like `truncated: true`, `shown`, `total`, and `retry_argv`.

### 2. If a value exists in another field, say where

- **Statement:** When a filter returns zero but the requested value exists in a sibling field/column, the CLI should name the correct field and give the corrected filter.
- **Evidence / failure class:** `c-wrong-column`. In the paired wrong-column experiment, `count` was changed to test the paired field when `class=X` or `subtype=X` returned zero. It emitted a correction like: `0 rows for subtype='bicycle_parking', but class='bicycle_parking' returns 1,844. Try --where class=bicycle_parking...`. On the matched subset (`bike-parking-coverage`, `residential-share-cambridge`, 2 repeats each), `c-wrong-column` fell from **2 to 0**. Source: `experiments/paired/count-wrong-column-hint/result.md`.
- **Confidence:** **confirmed narrowly**. It confirms the field-correction property, not full task success; other failures remained.
- **Design implication:** Treat “zero rows” as a diagnostic event, not just a result, when a nearby schema correction is available. Build column-swap checks into shared filter handling rather than one command at a time.

## 2. Principles suggested by baseline traces but not yet experimentally confirmed

### 3. Never return an unexplained empty result

- **Statement:** A successful empty result must distinguish “there are genuinely none” from “the agent asked in the wrong vocabulary, field, type, entity, or spelling.”
- **Evidence / failure class:** Class C silent wrong. Phase 4 found **55 C failures** in 60 records, including **25 `c-unknown`** and **25 `c-truncated`**. The `c-unknown` bucket is especially important: probes could not yet explain why the zero occurred, which means the CLI also did not provide enough evidence for the agent to know. Source: `agenteval-summary-with-retries.json`.
- **Confidence:** **hypothesis**, with strong baseline evidence but incomplete subtype attribution.
- **Design implication:** Empty results should carry diagnostic metadata: normalized filter, resolved field/type/entity, whether the value is known in the taxonomy, nearest known values, and safe next commands. Avoid bare `0`, empty arrays, or “0 rows” unless the CLI can justify that zero.

### 4. Name the fix, not just the problem

- **Statement:** Error messages and suspicious-zero diagnostics should include executable recovery advice, preferably a ready-to-run replacement command or corrected argument.
- **Evidence / failure class:** Class B vs A/C. Phase 4 had **15 B** guided failures and **38 A** hard unguided failures. The confirmed truncation and wrong-column fixes worked by adding exact recovery actions, not just by adding warnings. Arm C’s broad-context optimizer repeatedly asked for shared modules for `zero_results`, `errors`, and `suggest` to make recovery advice reusable.
- **Confidence:** **provisional**. Paired evidence supports it in truncation and wrong-column cases; broader A→B recovery still needs experiments.
- **Design implication:** Write diagnostics as agent instructions: “what happened,” “why this may not mean absence,” and “try this exact next command.” Prefer `retry_argv`/`retry_command` fields in structured output.

### 5. Make discovery first-class

- **Statement:** Agents should not have to enumerate huge lists, guess `--top`, or grep command output to discover valid values.
- **Evidence / failure class:** `c-truncated`, `c-unknown`, and high call counts in discovery-heavy questions. The baseline showed repeated category-list truncation: `categories --top 100/200/400` returned capped lists while larger limits revealed more rows. Arm D’s plan identifies a discovery-command experiment because the candidate subset has many truncation/unknown failures and 133 botmap calls over 10 attempts.
- **Confidence:** **hypothesis**. Truncation evidence is confirmed; a dedicated discovery command or prompt has not yet been paired-tested.
- **Design implication:** Provide commands like `categories --search TERM`, `values --search --type --field`, `schema --field`, and `explain-value VALUE`. Design help output for lookup, not browsing.

### 6. Advertise only values that work where they are advertised

- **Statement:** If help, categories, or examples list a value under a flag, using that value with that flag should work or the CLI should say the value belongs somewhere else.
- **Evidence / failure class:** `c-wrong-column`, `c-wrong-type`, and candidate properties in `docs/agent-friendly-cli.md`. The wrong-column paired experiment confirmed one slice: values that exist under another field need field-specific correction. Baseline also includes **3 `c-wrong-type`** cases.
- **Confidence:** **provisional/hypothesis**. Wrong-column is confirmed narrowly; wrong-type is planned but not yet confirmed.
- **Design implication:** Tie discovery output to valid invocation shapes. A taxonomy entry should expose field/type provenance and example filters. Avoid presenting `class`, `subtype`, type, and verb values as one flat vocabulary.

### 7. If data lives under another type or verb, name that route

- **Statement:** When a filter returns zero for one feature type but succeeds under another type/verb, the CLI should say so and give the corrected command.
- **Evidence / failure class:** `c-wrong-type`. Phase 4 found **3 `c-wrong-type`** failures. Arm D’s plan identifies this as the highest ready-to-run next experiment, with examples like `class=beach` under `land_use` or `water` where `land` works, and `subtype=military` under `building` where `land_use` works.
- **Confidence:** **hypothesis**, strong because it is the sibling of confirmed wrong-column behavior.
- **Design implication:** Generalize zero-result diagnostics across types/verbs. If `-t X --where field=value` returns zero, cheaply test plausible sibling types and produce `try -t Y ...` only when evidence is conclusive.

### 8. Confirm what entity was resolved

- **Statement:** Commands that accept place names should echo the resolved entity, including country/region and type, especially when the input is ambiguous.
- **Evidence / failure class:** Candidate `c-wrong-entity`. The original plan cites `where "Malta, MT"` resolving silently to Malta, Montana. However, the Phase 4 `c-wrong-entity` bucket was later found to be an instrumentation bug involving US state abbreviations vs ISO country codes, so the current valid baseline has no reliable `c-wrong-entity` count.
- **Confidence:** **hypothesis**.
- **Design implication:** Every `--in` or geocoded argument should emit a concise resolution echo: `resolved: Cambridge, Massachusetts, US (admin locality)` or JSON equivalent. For ambiguous inputs, require confirmation-like guidance or list alternatives.

### 9. Normalize common human spellings and aliases

- **Statement:** The CLI should accept obvious spellings, ASCII forms, aliases, singular/plural variants, and hyphen/underscore variants when the intended value is clear.
- **Evidence / failure class:** Baseline and Arm C qualitative signal. Arm C’s full-repo context run repeatedly asked for `botmap/placenames.py` for diacritic folding (`Reykjavik -> Reykjavík`) and `botmap/suggest.py` for aliases such as plural/singular and hyphen/underscore repairs. This aligns with candidate property “one obvious spelling should work.”
- **Confidence:** **hypothesis**.
- **Design implication:** Add normalization layers at boundaries: place-name normalization, taxonomy aliasing, command aliasing, and spelling suggestions. When normalization is applied, echo it so the agent learns the canonical form.

### 10. Emit progress or cost estimates for long operations

- **Statement:** A long-running command should show progress, expected cost, or a cheaper alternative so the agent does not abandon a correct command as hung.
- **Evidence / failure class:** Class D. Phase 4 found **3 D** degenerate failures. The plan cites operations with many minutes of silence. Arm D marks this as lower priority because the bucket is small and confounded by network/data latency.
- **Confidence:** **hypothesis**.
- **Design implication:** For known expensive routes, emit early stderr progress, estimates, or “this may take N minutes; for a faster approximate answer try ...”. Record silence intervals separately in future evaluators.

### 11. Make recovery advice actually work

- **Statement:** A hint is only agent-friendly if an agent can and does use it to recover; otherwise it should be recorded as ignored or misleading, not counted as success.
- **Evidence / failure class:** Class F design and ignored-hint instrumentation. The plan explicitly treats ignored hints as agent-side evidence. Phase 4 had no `agent_side_counts`, so this is not yet measured in the main distribution. Exit-0 did-you-mean decisions preserve the guided recovery path while recording non-use separately.
- **Confidence:** **hypothesis/provisional instrumentation principle**.
- **Design implication:** Hints should be exact, local, and executable. Evaluators should measure self-recovery rate and ignored-hint count, not only whether a message was printed.

## 3. Evaluator / instrumentation principles learned

### 12. Score the interface failure, not just final success

- **Statement:** A CLI usability evaluator must classify each call by outcome, blame, and recovery; final answer or old-style error counts miss the failures that matter.
- **Evidence / failure class:** New `agenteval` Phase 4 surfaced **55 C** silent-wrong failures in a bank that had previously looked saturated. Old scoring could mark attempts as fine while agents made confident wrong conclusions from unexplained zeros.
- **Confidence:** **confirmed for this experiment design**.
- **Design implication:** Use a taxonomy like: outcome (`ok`, `empty`, `error`, `degenerate`), blame (`tool`, `agent`, `environment`), recovery (`guided`, `unguided`, `n/a`), then derive classes. Treat class C as high severity.

### 13. Use differential probes to discover hidden CLI obligations

- **Statement:** When an agent sees a zero, the evaluator should ask cheap counterfactual CLI questions after the run: does the value exist elsewhere, under another type, beyond the limit, or under another entity?
- **Evidence / failure class:** Probes identified `c-truncated` and `c-wrong-column`, which became paired experiments and confirmed properties. `c-unknown=25` also shows where probes are insufficient.
- **Confidence:** **confirmed as an instrumentation method**.
- **Design implication:** Build post-run probes into evaluation. Do not put them in the agent transcript; they are measurement, not assistance. Record probe commands and evidence for audit.

### 14. Separate tool failures from environment and agent failures

- **Statement:** Network/quota/stale-release failures and ignored hints should be recorded, but not charged to the CLI as if the tool behavior were defective.
- **Evidence / failure class:** Class E and F design; Arm C wiring excluded attempt-level quota/environment failures from scoring. Historical invalid/stale runs showed that external failures can dominate apparent score movement if not separated.
- **Confidence:** **confirmed as a guardrail**.
- **Design implication:** Preflight release/network/quota; record environment failures; drop them from optimization objectives. Record ignored hints as agent-side evidence rather than treating the hint as a tool defect.

### 15. Keep the subject and the ruler separate

- **Statement:** Optimizers must not be allowed to edit evaluator files or evaluator-adjacent tests; otherwise they can improve the measurement instead of the CLI.
- **Evidence / failure class:** Arm C produced two invalid runs when `--all-files` included `botmap/evals/*` or evaluator-adjacent tests. They were stopped and marked invalid. Later safety commits excluded these from the edit surface.
- **Confidence:** **confirmed as an experimental-design requirement**.
- **Design implication:** Full-repo context can be read-only, but editable surfaces must exclude evaluator code, retained records, scoring logic, and tests of the scorer.

### 16. Record bypasses, do not immediately forbid them

- **Statement:** If an agent answers via web search or non-CLI tools, record that fact separately rather than pretending it measures CLI usability.
- **Evidence / failure class:** The plan notes `hotel-density-two-countries` used zero botmap commands and still scored 1.00 under older interpretation. The current contract records `tools_used` and `botmap_calls` without yet judging bypasses.
- **Confidence:** **provisional instrumentation principle**.
- **Design implication:** Keep real agent capabilities available, but track whether the CLI was bypassed. Later classify bypasses by reason: vocabulary discovery vs answer lookup.

## 4. Anti-patterns: what makes a CLI hostile to agents

### 17. Bare zero / empty output

- **Statement:** Returning `0`, `[]`, or “0 rows” without context is hostile because agents interpret it as factual absence.
- **Evidence / failure class:** Class C, especially `c-unknown`, `c-wrong-column`, `c-wrong-type`, and candidate `c-vocabulary`.
- **Confidence:** **provisional**, with confirmed slices.
- **Design implication:** Add diagnostic context to every suspicious empty result.

### 18. Silent truncation

- **Statement:** Returning the first N results without saying more exist is hostile because agents treat the sample as complete.
- **Evidence / failure class:** `c-truncated`; paired reduction from 13 to 5 after hint.
- **Confidence:** **confirmed**.
- **Design implication:** Explicit truncation markers and retry commands are mandatory.

### 19. Flat vocabularies with hidden columns/types

- **Statement:** Showing values without saying which field/type/verb accepts them causes agents to use real values in invalid places.
- **Evidence / failure class:** `c-wrong-column` confirmed narrowly; `c-wrong-type` baseline.
- **Confidence:** **provisional**.
- **Design implication:** Discovery output should be typed and field-aware.

### 20. Raw tracebacks and parser dead ends

- **Statement:** Raw stack traces or terse parser errors leave agents stuck or looping.
- **Evidence / failure class:** Class A had **38** events in Phase 4. Arm D’s plan identifies A→B recovery as a large remaining target after triage.
- **Confidence:** **hypothesis/provisional**.
- **Design implication:** Convert common raw errors into guided failures with exact syntax corrections; keep stack traces behind debug flags.

### 21. Ad hoc hints scattered through commands

- **Statement:** A hint in one command path but not another makes the CLI inconsistent; agents cannot form reliable recovery expectations.
- **Evidence / failure class:** Confirmed wrong-column/truncation properties and Arm C repeated requests for shared modules (`zero_results`, `suggest`, `errors`).
- **Confidence:** **provisional**.
- **Design implication:** Centralize diagnostics and suggestions in shared helpers.

### 22. Long silence

- **Statement:** Minutes of no output look like a hang to an agent, even if the command is correct.
- **Evidence / failure class:** Class D=3 and plan examples.
- **Confidence:** **hypothesis**.
- **Design implication:** Emit progress/heartbeat/cost estimates for expensive operations.

### 23. Optimizer-editable evaluation apparatus

- **Statement:** In experiments, letting the optimizer edit the evaluator or its tests is hostile to truth.
- **Evidence / failure class:** Arm C invalid runs.
- **Confidence:** **confirmed**.
- **Design implication:** Lock evaluator files out of edit surfaces.

## 5. What a CLI author should do differently tomorrow

1. **Add truncation notices everywhere.**
   Any command with `--limit`, `--top`, pagination, sampling, ranking, or implicit caps should print whether the output is complete and how to retrieve more.

2. **Upgrade zero-result handling.**
   For filtered queries, a zero should echo the resolved type, field, value, and entity; check cheap alternatives; and distinguish true zero from suspicious zero.

3. **Make errors actionable.**
   Replace “invalid option,” raw tracebacks, and schema complaints with messages that include a valid replacement command. In JSON mode, include structured recovery fields.

4. **Make discovery searchable and typed.**
   Add search commands for categories/values/schema. Include field/type provenance and example invocations in discovery output.

5. **Echo resolution and normalization.**
   When the CLI resolves place names, canonical values, aliases, or spellings, show what it resolved to. Agents need to verify they are asking about the intended thing.

6. **Centralize diagnostics.**
   Do not implement near-match hints one command at a time. Build shared modules for zero-result explanation, suggestions/aliases, placename normalization, and error formatting.

7. **Design stderr/stdout/JSON deliberately.**
   Human-readable stderr is useful to agents, but JSON users need structured equivalents. Avoid changing data stdout in a way that breaks scripts; attach metadata where possible.

8. **Track self-recovery, not just success.**
   Measure whether the agent used the hint, how many extra calls/tokens it spent, and whether the final answer became correct.

9. **Keep experimental boundaries sharp.**
   If optimizing the CLI, never let the optimizer edit the evaluator. Preserve old records and write new record versions instead of rewriting history.

## Top-level synthesis

The core principle is:

> An agent-friendly CLI is one that turns ambiguity into observable state and executable next actions.

The confirmed evidence is narrow but consistent. Silent truncation and wrong-column zeros both harmed agents because the CLI had information the agent needed and did not surface it. When the CLI surfaced that information with concrete recovery actions, the corresponding failure classes fell. The broader baseline and Arm C observations suggest the same pattern generalizes to zero-result diagnostics, type/verb routing, place normalization, raw errors, discovery, and long-running commands.
