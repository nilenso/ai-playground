# Arm D insights

## 1. What Arm D was testing

Arm D planned and began the next experimental wave for deriving agent-friendly CLI design principles from botmap. The first executed experiment targeted the remaining `c-wrong-type` bucket:

> If the same filter returns zero under one feature type but returns rows under another feature type, the CLI should name the correct type and give the exact retry command before the agent concludes the data is absent.

This is the type-level analogue of the already confirmed wrong-column hint property.

## 2. What ran / did not run

### Ran

- **Plan memo:** `experiments/arm-d/PLAN.md`
- **Botmap candidate worktree:** `/Users/priyangapkini/workspace/ar-d/botmap-wrong-type-hint`
- **Botmap candidate branch:** `arm-d/wrong-type-hint-tool`
- **Botmap candidate commit:** `9ba1187` — `Hint when zero count matches another type`
- **Run directory:** `experiments/runs/after-wrong-type-hint-tool-9ba1187/`
- **Run driver:** `experiments/arm-d/run_wrong_type_hint.py`
- **Subset:** `beach-accessibility-malta`, `residential-share-cambridge`, 2 repeats each
- **BEFORE source:** `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`
- **AFTER summary:** `experiments/runs/after-wrong-type-hint-tool-9ba1187/agenteval-summary.json`
- **Enrichment summary:** `experiments/runs/after-wrong-type-hint-tool-9ba1187/enrichment-summary.json`

The first enrichment pass failed on a CLI-only probe timeout. Per user request, enrichment was rerun only, with a larger timeout. That rerun completed and wrote the AFTER summary.

### Did not run

- No full-bank replication was run by Arm D.
- No GEPA/optimizer run was run by Arm D.
- No A→B recovery experiment was run by Arm D.
- No instruction-vs-tool comparison was run by Arm D.
- No zero-result diagnostics, discovery command, entity echo, or progress/estimate experiment was run by Arm D.

## 3. Key quantitative results so far

### Baseline subset

BEFORE source: `experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json`

Subset: `beach-accessibility-malta`, `residential-share-cambridge` × 2 repeats.

Baseline failures on this subset:

```json
{
  "c-truncated": 2,
  "c-unknown": 7,
  "A": 3,
  "c-wrong-type": 3,
  "B": 2,
  "c-wrong-column": 1
}
```

The exact `c-wrong-type` BEFORE calls were:

- `beach-accessibility-malta__r1`: `count -t land_use ... --where class=beach`; probe found `land` returned 65.
- `beach-accessibility-malta__r1`: `count -t water ... --where class=beach`; probe found `land` returned 65.
- `residential-share-cambridge__r2`: `count -t building ... --where subtype=military`; probe found `land_use` returned 1.

### Arm D AFTER run

Run status:

```json
{
  "attempts_done": 4,
  "total": 4,
  "completed": 2,
  "ok": 2,
  "botmap_calls": 39,
  "cost_usd": 0.8831648000000001,
  "minutes": 49.5
}
```

AFTER class histogram:

```json
{
  "clean": 35,
  "B": 3,
  "C": 1
}
```

AFTER subtype histogram:

```json
{
  "c-unknown": 1
}
```

Primary target movement on the matched subset:

```text
c-wrong-type: 3 → 0
```

Other visible movement, with caution because only 2 of 4 attempts completed:

```text
A:              3 → 0 observed in summary
c-wrong-column: 1 → 0 observed in summary
c-unknown:      7 → 1 observed in summary
```

These secondary movements are not attributable cleanly to the wrong-type hint. They may reflect stochastic agent behavior, incomplete attempts, different routes, or interaction with pre-existing guidance.

Enrichment details:

```json
{
  "attempts": 4,
  "calls_seen": 39,
  "calls_probed": 3,
  "probe_calls": 12
}
```

## 4. Qualitative insights about agent-friendly CLI design

1. **Type mismatch is a real CLI observability failure, not a capability failure.** In the BEFORE traces, botmap could answer the query under another type, but the zero-count result did not expose that fact. The agent had to guess the ontology boundary between `land`, `land_use`, `water`, and `building`.

2. **The useful hint is concrete, not conceptual.** The candidate did not merely say “try another type.” It named the alternate type and emitted a copy/pasteable command. This matches the broader pattern already seen in truncation and wrong-column experiments: agents benefit when the CLI names the exact recovery action.

3. **Zero is dangerous when the data model has parallel namespaces.** A count of zero can mean “none exist,” “wrong field,” “wrong type,” “wrong vocabulary,” or “unsupported filter.” Agent-friendly CLIs should not make the agent infer which meaning applies.

4. **Tool-side guidance appears promising for ontology errors.** This wrong-type hint is structurally similar to the confirmed wrong-column hint: a cheap differential check on the failure path can turn silent wrong output into guided recovery.

5. **Post-run probes are essential but can become their own operational risk.** The first enrichment failed because a truncation probe against Malta timed out. Probe timeouts should be treated as measurement fragility, not agent/tool behavior.

## 5. What claims are supported vs tentative

### Supported narrowly

- On the selected matched subset, adding a tool-side wrong-type hint eliminated observed `c-wrong-type` classifications: **3 → 0**.
- The candidate can convert at least one wrong-type zero into a guided class-B call; the AFTER summary includes a B on `count -t land_use ... class=beach`, indicating the hint path was visible to the evaluator.

### Tentative / not yet supported broadly

- “If data exists under another type, say where” is **provisionally supported**, but not yet confirmed across the full bank.
- The experiment does **not** prove final answer correctness improved. The primary reported metric was failure-class movement, not answer verification.
- The experiment does **not** prove token/call efficiency improved. The AFTER run had only 4 attempts and 2 completed attempts.
- The experiment does **not** prove the same approach is safe for all types. The candidate loops over all Overture types on the zero-count path; this may be too slow or noisy at full scale.
- The apparent reductions in A, c-wrong-column, and c-unknown are not attributable to this candidate without more controlled replication.

## 6. Failure modes / confounders / invalid runs

- **Incomplete attempts:** 2 of 4 AFTER attempts did not complete. Treat the result as narrow/provisional.
- **Enrichment timeout:** Initial enrichment failed on `botmap --json categories -t place --in Malta --top 500` after 120s. Rerun with a larger timeout completed. This shows the enrichment layer can introduce fragility unrelated to paid agent behavior.
- **Candidate performance risk:** The tool-side implementation probes alternate types after a zero count. This may add expensive scans on legitimate zero results. Full-bank testing should watch wall-clock and timeout rate carefully.
- **Stochastic route changes:** The agent may not hit the same exact failure sequence in AFTER attempts. Class reduction is encouraging, but trace-level comparison is needed before claiming mechanism.
- **Evaluator classification risk:** A prior MA/MT entity ambiguity bug caused false `c-wrong-entity`; this experiment did not expose a similar known bug, but the lesson remains: probe evidence must be audited before broad claims.
- **Worktree/code state:** The candidate was created in an external botmap worktree. Autoresearch files outside `experiments/arm-d/` already had unrelated modifications in the repo before/while Arm D worked; those should not be attributed to Arm D’s planned experiment except for files under `experiments/arm-d/`.

## 7. Recommendation for next experiments

Given the user halt, do not run anything now. If experiments resume later, recommended sequence:

1. **Write a paired result memo** for `after-wrong-type-hint-tool-9ba1187`, explicitly labelling the verdict “confirmed narrowly/provisionally” because only 2/4 attempts completed.
2. **Audit the wrong-type candidate for cost/safety** before any full-bank run. In particular, bound alternate-type probes and avoid scanning types whose schema cannot contain the filter.
3. **Run a small retry-only paired subset** if budget allows later, replacing the two incomplete attempts rather than rerunning all four.
4. **Then full-bank replicate only if the retry subset still shows `c-wrong-type=0` without timeout regression.**
5. **Before A→B recovery, do zero-spend taxonomy triage** of class A because some `no_match` messages appear guided but may currently classify as A.
6. **Before zero-result diagnostics, improve probes** to split `c-unknown` into vocabulary/canonicalization/unsupported-column/true-zero buckets. Otherwise a zero-diagnostics experiment risks overclaiming from instrumentation gaps.

## 8. Anything the blog/derivation sessions should know

- The strongest emerging pattern is **“make invisible interpretation visible.”** The CLI already has or can cheaply discover the facts needed for recovery: output was truncated, a value belongs to another field, or a filter belongs to another type.
- The design principle should be phrased as: **A zero result should carry a falsifiable explanation or a safe next probe.** A bare zero is not agent-friendly.
- The wrong-type experiment is a clean example of the taxonomy generating a design property: `c-wrong-type` directly maps to “if the data lives under another type, name that route.”
- Do not present this as a broad confirmed property yet. The honest claim is: **on a small matched subset, a tool-side wrong-type hint removed the measured wrong-type subtype; full-bank generality remains untested.**
- The measurement story matters as much as the product story: enrichment/probe timeouts show that evaluation infrastructure needs the same agent-friendly qualities — bounded work, progress, and clear failure semantics — as the CLI under test.
