# General principles: what makes a CLI agent-friendly?

This synthesis is based on the autoresearch/botmap measurements so far, especially:

- `docs/agent-friendly-cli.md`
- `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`
- `experiments/paired/categories-truncation-hint/result.md`
- `experiments/paired/count-wrong-column-hint/result.md`
- Arm A's new-evaluator candidate-screening observations
- `experiments/arm-d/PLAN.md`

The current evidence base is mixed: two properties have paired evidence; many more are supported by baseline traces and differential probes but not yet by paired BEFORE/AFTER experiments. The safest answer is therefore a ranked set of principles with confidence labels.

## Summary answer

An agent-friendly CLI is not merely a CLI with more features. It is a CLI that makes its own state, assumptions, limits, and recovery paths observable at the exact moment the agent is likely to go wrong. The strongest recurring pattern is that agents are defeated less by missing capability than by underspecified success: exit 0, empty output, silent truncation, silent coercion, or a generic error that leaves them guessing.

In short:

> Agent-friendly CLIs turn ambiguous outcomes into auditable, actionable next steps.

## 1. Principles supported by paired evidence

### 1.1 Never silently truncate output

- **Statement:** If a CLI returns a limited list, it should say the list is truncated and name the exact command to retrieve enough data before concluding absence.
- **Evidence / failure class:** Confirmed against `c-truncated`. In the Phase 4 baseline, `categories --top N` frequently returned exactly `N` rows; larger differential probes found more rows. Agents treated capped lists as complete. In the paired truncation experiment, `c-truncated` fell from **13 to 5** on the matched subset after botmap emitted a truncation notice and retry advice.
- **Confidence:** **confirmed / provisional**. Confirmed on the paired subset; provisional because one AFTER attempt still timed out and it was not full-bank replication.
- **Design implication:** Every paginated, capped, sampled, or top-N command should include machine-readable and human-readable metadata: `returned`, `available` if known, `truncated: true`, and a ready-to-run continuation or larger-limit command. Do not rely on the agent inferring that exact-limit output may be incomplete.

### 1.2 If a value exists elsewhere, say where

- **Statement:** If a filter value is real but used in the wrong field, the CLI should identify the correct field and provide the corrected filter.
- **Evidence / failure class:** Confirmed against `c-wrong-column`. In the paired count wrong-column experiment, `c-wrong-column` fell from **2 to 0** on the matched subset after `count` checked the paired field and emitted advice like: `0 rows for subtype='bicycle_parking', but class='bicycle_parking' returns 1,844. Try --where class=bicycle_parking ...`.
- **Confidence:** **confirmed narrowly**. The targeted failure disappeared on the matched subset; other failures remained.
- **Design implication:** For structured filters, CLIs should validate not only whether a value works in the requested column but whether it works in sibling columns. Error or diagnostic messages should include the column name, observed alternate count, and exact retry syntax.

### 1.3 Name the recovery action, not just the problem

- **Statement:** A CLI should provide a concrete next command or corrected argument whenever it can detect a likely user/agent mistake.
- **Evidence / failure class:** Supported by the two paired experiments above: both successful changes worked by adding actionable guidance, not new underlying data capability. Truncation hint named `--top TOTAL` / larger `--top`; wrong-column hint named the corrected `--where` field.
- **Confidence:** **confirmed as a common mechanism inside the two confirmed properties**, but broader forms remain provisional.
- **Design implication:** Prefer messages of the form: `What happened -> why it may be misleading -> exact next command`. Avoid messages that only say `invalid`, `0 rows`, or `not found`.

## 2. Principles suggested by baseline traces but not yet experimentally confirmed

### 2.1 Never return an empty result without explaining why

- **Statement:** A successful zero result should distinguish true absence from likely wrong vocabulary, wrong field, wrong type, unsupported column, truncation, or ambiguous entity resolution.
- **Evidence / failure class:** Phase 4 had **55 Class C** calls, the heaviest failure class. `c-unknown` was **25** of those, meaning empty results remained unexplained by current probes. Baseline examples include zero counts that agents interpreted as real absence.
- **Confidence:** **hypothesis**. Strong baseline signal, but no paired zero-diagnostic experiment yet.
- **Design implication:** Exit-0 empty responses should include diagnostic metadata: `empty_reason`, `checked_field`, `known_near_values`, `other_fields_with_value`, `other_types_with_value`, and `confidence`. If the tool cannot tell, it should say `empty reason unknown` rather than implying absence.

### 2.2 Make discovery a first-class operation

- **Statement:** Agents should not have to guess taxonomy values by fetching large top-N lists and grepping. The CLI should provide targeted search/discovery commands.
- **Evidence / failure class:** Baseline had heavy `c-truncated` and `c-unknown` around category discovery. Arm D identifies discovery as broad but confounded: candidate subset includes `asian-restaurants-rollup`, `bike-parking-coverage`, `bus-stops-cambridge`, `ev-charging-gap`, and `tattoo-category-discovery`, with many truncation/unknown failures and high command counts.
- **Confidence:** **hypothesis / strong baseline suggestion**. Truncation was confirmed; a dedicated discovery command has not been paired-tested.
- **Design implication:** Add commands such as `categories --search TERM`, `values --type place --field categories.primary --search bus`, and `schema values --field FIELD`. Discovery should be cheap, bounded, and obvious in help text.

### 2.3 If a value exists under another type, say which type

- **Statement:** If a filter returns zero for one feature type but succeeds for another, the CLI should name the correct type and retry command.
- **Evidence / failure class:** Phase 4 found **3 `c-wrong-type`** failures. Arm D identifies this as the next clean experiment: e.g. `class=beach` under `land_use`/`water` where `land` works, or `subtype=military` under `building` where `land_use` works.
- **Confidence:** **hypothesis with direct probe evidence**. Differential probes support that the information exists; no paired AFTER yet.
- **Design implication:** Cross-type diagnostics should be part of zero-result handling. If `-t land_use class=beach` is empty but `-t land class=beach` has rows, stderr/JSON should say so and give the corrected command.

### 2.4 Confirm what entity was resolved

- **Statement:** Any command that resolves a place or entity should echo the resolved entity, including country/region/type, so agents notice ambiguity before using the wrong geography.
- **Evidence / failure class:** Original plan included `c-wrong-entity` from examples like `Malta, MT`; later Phase 4 repair found the initial MA/MT entity-probe bucket was an instrumentation bug. Arm D notes current Phase 4 has no valid `c-wrong-entity` after repair and needs a deliberate ambiguous-location mini-bank.
- **Confidence:** **hypothesis**. Conceptually strong and supported by anecdotal traces, but current measured bucket was invalidated.
- **Design implication:** Commands with `--in` should echo `resolved: Malta (country, MT)` vs `Malta (locality, US-MT)`. Ambiguous resolutions should be structured and visible, not only buried in prose or omitted under JSON.

### 2.5 Emit progress and estimates for long operations

- **Statement:** Long-running commands should emit progress, expected cost/time, or a cheaper alternative so the agent does not abandon a correct command as hung.
- **Evidence / failure class:** Phase 4 had **3 Class D** degenerate route failures. The plan and old Arm A findings mention geometry/containing routes with long silence. Arm D rates this as lower priority because D is small and confounded with data/network slowness.
- **Confidence:** **hypothesis**.
- **Design implication:** For known expensive operations, emit early stderr such as: `This may take ~10-20 minutes; for a bbox use ...; progress ...`. Also expose `--estimate`, `--dry-run`, or cheaper summary commands.

### 2.6 Support obvious spellings and option placement

- **Statement:** The CLI should accept common agent spellings and option placements, or fail with exact correction.
- **Evidence / failure class:** Old Arm A identified `--json` only working before the subcommand, and `count` missing shortcuts like `--category` / `--class`. Arm A's `count-flag-parity` candidate was intended to test this, but the new-evaluator run was halted and old screening suggested the new flags were rarely reached.
- **Confidence:** **hypothesis**.
- **Design implication:** Use parser aliases for common spellings and consistent global/subcommand option placement. If not accepted, error messages should say exactly where the option belongs.

### 2.7 Advertise only values that work

- **Statement:** Help and value lists should not advertise values that produce silent zero under the documented flag/field.
- **Evidence / failure class:** Plan examples include `--class` help listing values that are really `subtype` values. This overlaps with `c-wrong-column` and `c-wrong-type`.
- **Confidence:** **hypothesis with related confirmed evidence**. Wrong-column is confirmed; advertised-value cleanup itself has not been paired-tested.
- **Design implication:** Help text should be generated from the same schema/value mapping the command actually uses. If a value belongs to `subtype`, do not list it under `--class` without saying so.

### 2.8 Recovery advice must be executable and cheap enough to use

- **Statement:** A hint is only helpful if the suggested command works, returns promptly, and is appropriate for the agent's current task.
- **Evidence / failure class:** Plan notes `no_match` recommending a command that can take ten minutes and print nothing. Arm A's run observed `ignored_hint` on `count-zero-hint`, showing that giving a hint does not guarantee self-recovery.
- **Confidence:** **hypothesis / qualitative support**.
- **Design implication:** Treat recovery advice as an API contract. Test suggested commands. Prefer minimal, bounded retries over broad downloads or expensive scans.

## 3. Evaluator / instrumentation principles learned

### 3.1 Score the recovery path, not just the first failure

- **Statement:** A wrong first command followed by useful guidance and successful recovery is a different outcome from a wrong first command followed by silence and a confident false answer.
- **Evidence / failure class:** The old scorer penalized `did you mean` hints as errors, making helpful diagnostics look worse than silent zeros. The new taxonomy separates Class B guided failures, Class C silent wrongs, and Class F agent-side ignored hints. Arm A's `count-zero-hint` run produced Class B calls plus an `ignored_hint`, validating the need for this distinction.
- **Confidence:** **confirmed as evaluator principle**.
- **Design implication:** Evaluation should track guidance quality, self-recovery rate, recovery cost, and final outcome separately. Do not optimize only for fewer errors.

### 3.2 Silent wrong is worse than honest failure

- **Statement:** A crash or usage error is visible; an exit-0 empty result can cause a confident wrong final answer. Evaluators should weight silent wrong failures heavily.
- **Evidence / failure class:** Phase 4 found **55 Class C** calls, many invisible under old scoring. The project's confirmed properties both reduce Class C subtypes.
- **Confidence:** **confirmed as evaluator principle; supported as CLI design principle**.
- **Design implication:** Treat ambiguous success as dangerous. Build tests and logs around `exit_code=0` cases, not only nonzero exits.

### 3.3 Differential probes are powerful but must be bounded

- **Statement:** Post-agent CLI-only probes can reveal whether the tool had information it failed to surface, but probe execution itself must be timeout-safe and inconclusive rather than fatal.
- **Evidence / failure class:** Phase 4 used probes to identify `c-truncated`, `c-wrong-type`, and `c-wrong-column`. Arm A's full candidate screening later failed enrichment because `categories --top 2000/5000` probe commands timed out and aborted summary writing.
- **Confidence:** **confirmed as instrumentation lesson**.
- **Design implication:** Evaluators should record probe timeout as an inconclusive probe result and continue. Probe budgets, timeouts, and audit logs are part of the measurement contract.

### 3.4 Record bypasses instead of banning real-agent tools too early

- **Statement:** If an agent uses web search or other tools, record it before deciding whether to penalize it.
- **Evidence / failure class:** Plan notes `hotel-density-two-countries` used zero botmap commands and succeeded via web search. The agreed evaluator records `tools_used` and `botmap_calls` without judging it yet.
- **Confidence:** **provisional instrumentation principle**.
- **Design implication:** Real agents have multiple tools. A CLI evaluation should distinguish “agent routed around the CLI for vocabulary discovery” from “agent answered without measuring the CLI,” but should not guess without data.

### 3.5 Preserve history; do not rescore old records in place

- **Statement:** When the evaluator changes, write new records and summaries; do not rewrite old attempts as if they had always used the new schema.
- **Evidence / failure class:** The project intentionally writes `record-v2.json` beside old artifacts and combines successful retries without mutating original runs.
- **Confidence:** **confirmed process principle**.
- **Design implication:** Evaluation artifacts should be append-only and schema-versioned. This is especially important when the evaluator itself is part of the research.

## 4. Anti-patterns: what makes a CLI hostile to agents

### 4.1 Ambiguous success

- **Statement:** Exit 0 plus empty output, with no explanation, is hostile because agents interpret it as a factual answer.
- **Evidence / failure class:** Class C, especially `c-unknown`, `c-wrong-column`, `c-wrong-type`, and vocabulary-like zeros.
- **Confidence:** **provisional / strong baseline support**.
- **Design implication:** Do not let `0` mean both “none exist” and “you asked the wrong way.”

### 4.2 Silent truncation

- **Statement:** Returning exactly the requested top-N without saying more exists causes agents to conclude absent categories do not exist.
- **Evidence / failure class:** `c-truncated`; paired evidence reduced 13 -> 5.
- **Confidence:** **confirmed**.
- **Design implication:** Always expose truncation status and continuation advice.

### 4.3 Schema opacity

- **Statement:** If the CLI knows fields, types, and values but does not connect a failed query to the right schema location, agents waste commands guessing.
- **Evidence / failure class:** `c-wrong-column` confirmed; `c-wrong-type` suggested.
- **Confidence:** **confirmed for wrong-column; hypothesis for wrong-type**.
- **Design implication:** Surface schema relationships in diagnostics, not only in separate docs.

### 4.4 Raw parser errors without repaired command forms

- **Statement:** Usage errors that only show generic parser output often produce loops or abandonment.
- **Evidence / failure class:** Class A=38 in baseline; Arm D identifies A→B recovery as a high-value next experiment, after triaging possible misclassification.
- **Confidence:** **hypothesis**.
- **Design implication:** Parser errors should include accepted syntax and an exact rewrite of the user's command when possible.

### 4.5 Global or user-local configuration leaking into experiments

- **Statement:** Agent behavior becomes unreproducible when global skills/config shadow project instructions.
- **Evidence / failure class:** Arm A found global `~/.claude/skills/botmap` shadowed project-scoped botmap skill, voiding prompt-lever experiments until `--setting-sources project` and disabling the global skill.
- **Confidence:** **confirmed instrumentation/process lesson**.
- **Design implication:** For agent-facing CLI evaluation, isolate instructions and record tool/skill sources. For CLI authors, assume agents may have stale external instructions; make live CLI output self-describing.

## 5. What a CLI author should do differently tomorrow

1. **Add truncation metadata and recovery text to every limited listing.** Include `truncated`, `returned`, `limit`, and a next command.
2. **Make zero results diagnostic.** If a query returns zero, check likely vocabulary/field/type mistakes and report what was checked.
3. **When rejecting or warning, print the corrected command.** Do not merely say what is wrong.
4. **Echo resolved entities and assumptions.** For any `--in`, geocode, default release, filter coercion, or inferred type, show what the CLI actually used.
5. **Make schema/value discovery cheap and searchable.** Agents should not need to page through huge lists to find category names.
6. **Treat help examples as executable tests.** Every suggested recovery command should be valid, bounded, and fast enough for an agent loop.
7. **Support common spellings and placements.** Where aliases are safe, accept them; where not, return exact correction.
8. **Separate human-friendly prose from machine-readable diagnostics.** Agents can use stderr prose, but JSON fields make recovery and evaluation more reliable.
9. **Design for the second command.** The first command will often be wrong; agent-friendly CLIs make the second command obvious.
10. **Instrument self-recovery.** Track whether guidance was used, how many extra calls it cost, and whether the final answer recovered.

## Confidence-ranked principle table

| Principle | Statement | Evidence / failure class | Confidence | Design implication |
|---|---|---|---|---|
| Never silently truncate | Say when output hit a limit and how to get more | `c-truncated`; paired 13 -> 5 | confirmed/provisional | Add truncation metadata and retry command |
| Say where a value works | If a value exists in another field, name that field | `c-wrong-column`; paired 2 -> 0 | confirmed narrowly | Cross-check sibling fields on zero results |
| Name recovery action | Give exact next command, not just problem | Mechanism in both paired wins | confirmed as mechanism | Format diagnostics as actionable retries |
| Explain empty results | Zero should not imply true absence without evidence | Class C=55; `c-unknown`=25 | hypothesis | Add zero-result diagnostics |
| Make discovery searchable | Do not force top-N guessing | `c-truncated`, `c-unknown`, high call counts | hypothesis | Add `--search` / values discovery |
| Say correct type | If value exists under another type, name it | `c-wrong-type`=3 | hypothesis with probe evidence | Cross-type zero-result hints |
| Echo resolved entity | Show what `--in` resolved to | Invalidated probe bucket; anecdotal traces | hypothesis | Structured entity echo in every scoped command |
| Emit progress | Long operations need progress/estimate | Class D=3; old long-silence traces | hypothesis | Progress stderr, estimates, cheap alternatives |
| Score recovery paths | Distinguish guided recovery from silent wrong | New evaluator; Arm A ignored-hint observation | confirmed instrumentation | Track B/C/F separately |
| Bound evaluator probes | Probe failures must be inconclusive, not fatal | Arm A enrichment timeouts | confirmed instrumentation | Timeout-safe probe records |

## Bottom line

The experiments support a general design rule: **an agent-friendly CLI is observable and corrective at its failure boundaries.** It should not make the agent infer whether output is complete, whether a zero is meaningful, which field/type/entity was used, or what to try next. The two strongest paired results both came from making implicit tool knowledge explicit at the point of confusion.
