# What makes a CLI agent-friendly?

This is the living deliverable for the autoresearch experiment. Each entry must
be backed by measurement. Hypotheses may be listed only when there is a BEFORE
trace; a property is not confirmed until a paired BEFORE/AFTER run shows the
agent did better under the same conditions.

## Evidence levels

- **Tier 1 — candidate:** a differential probe shows the tool had information it
  did not surface.
- **Tier 2 — confirmed/refuted:** a paired run shows whether surfacing that
  information helped the agent recover unaided.

## Entry template

```text
PROPERTY    what an agent-friendly CLI does
VIOLATION   the failure class that appears when it is missing
STATUS      hypothesis | confirmed | refuted

BEFORE      measured trace of an agent defeated by its absence
CHANGE      actual change and lever: tool | instructions
AFTER       measured trace with the change in place
VERDICT     confirmed | refuted, and the delta that supports it
```

## Evaluation rubric

Top-level score:

- Correctness and recoverability: **60%**
- Token efficiency: **20%**
- Wall-clock time: **20%**

The correctness/recoverability 60% is split into:

- Final outcome correctness: **20 points**
- Self-recovery: **20 points** — can the agent diagnose and recover without human help?
- Guidance / error quality: **12 points** — does the CLI explain what went wrong and what to do next?
- Execution / route quality: **6 points**
- Failure severity / attribution: **2 points**

Track **Self-Recovery Rate** separately:

```text
recoverable failures successfully recovered by the agent / total recoverable failures
```

Also track recovery cost: extra tokens, calls, and wall-clock time.

## Phase 4 measurement distribution

Measurement run:

```text
experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
```

This combines the 60-attempt Phase 4 run with the two successful retry attempts
for transient timeouts, leaving the original run artifacts untouched.

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2},
  "agent_side_counts": {}
}
```

The largest evidenced candidate is currently `c-truncated`: taxonomy/discovery
output hit a limit, the agent treated the capped list as complete, and raising
the limit revealed more rows. The next largest bucket is `c-unknown`, which means
our probes could not yet explain the empty result; this is an instrumentation
work queue, not proof that the CLI behaved well.

## Confirmed properties

### Never silently truncate output

PROPERTY    An agent-friendly CLI says when an output list hit a limit and names
            the exact recovery action.
VIOLATION   `c-truncated`: the agent reads a capped list as complete and concludes
            a value/category does not exist.
STATUS      confirmed

BEFORE      In the Phase 4 run, `categories --top N` frequently returned exactly
            N rows with no truncation notice. A differential probe with a larger
            `--top` found more rows. On the paired subset
            (`bike-parking-coverage`, `basic-category-rollup`,
            `bus-stops-cambridge`, 2 repeats each), the BEFORE trace had:

```json
{"c-truncated": 13, "B": 5, "A": 3, "c-wrong-column": 1, "c-unknown": 7}
```

CHANGE      Tool lever. Botmap candidate `00bff1a` changes `categories` to emit
            stderr when `--top` truncates the list:

```text
[botmap] Showing top N of TOTAL categories. This list is truncated; rerun with
`--top TOTAL` or a larger --top before concluding a category is absent.
```

AFTER       Paired AFTER run:

```text
experiments/runs/after-categories-truncation-hint-00bff1a/
```

```json
{"c-truncated": 5, "B": 2, "c-unknown": 2, "A": 1}
```

VERDICT     Confirmed provisionally. `c-truncated` fell from **13 to 5** on the
            matched subset. One AFTER attempt still timed out, and this is a
            subset result, but the measured direction is strong enough to keep
            the property.

### If a value exists elsewhere, say where

PROPERTY    If a filter value exists in another field, an agent-friendly CLI
            names that field and gives the corrected filter.
VIOLATION   `c-wrong-column`: the agent uses a real value in the wrong column,
            gets zero, and treats the zero as absence.
STATUS      confirmed

BEFORE      On the paired subset (`bike-parking-coverage`,
            `residential-share-cambridge`, 2 repeats each), the BEFORE trace had:

```json
{"c-truncated": 5, "B": 3, "c-wrong-column": 2, "c-unknown": 6, "A": 1, "c-wrong-type": 1}
```

CHANGE      Tool lever. Botmap candidate `7c794ff` changes `count`: when
            `class=X` or `subtype=X` returns zero, it tests the paired field and
            emits a concrete correction if that field has rows.

```text
[botmap] 0 rows for subtype='bicycle_parking', but class='bicycle_parking'
returns 1,844. Try `--where class=bicycle_parking` before concluding none exist.
```

AFTER       Paired AFTER run:

```text
experiments/runs/after-count-wrong-column-hint-7c794ff/
```

```json
{"c-truncated": 3, "B": 2, "c-vocabulary": 2, "A": 1}
```

VERDICT     Confirmed narrowly. `c-wrong-column` fell from **2 to 0** on the
            matched subset. Other failures remain, so this confirms the column
            guidance property, not full task success.

## Current candidate properties

These are hypotheses from `docs/plan.md`. They are waiting for Phase 4 BEFORE
traces and later paired Phase 6 experiments.

1. Never return an empty result without saying why.
2. Name the fix, not just the problem.
3. Never silently discard input.
4. Never silently truncate output.
5. Make discovery a first-class operation.
6. Advertise only values that work.
7. Confirm what you resolved.
8. Emit progress on long operations.
9. Recovery advice must actually work.
10. One obvious spelling should work.
