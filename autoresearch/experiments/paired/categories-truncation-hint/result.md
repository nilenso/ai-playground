# Paired experiment — categories truncation hint

Property: **Never silently truncate output.**

Lever: **tool**

Candidate commit in botmap clone:

```text
/Users/priyangapkini/workspace/ar-b/botmap @ 00bff1a Warn when categories output is truncated
```

Change: `botmap categories --top N` now emits a stderr notice when more than `N`
categories exist:

```text
[botmap] Showing top N of TOTAL categories. This list is truncated; rerun with
`--top TOTAL` or a larger --top before concluding a category is absent.
```

## BEFORE

Source:

```text
experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
```

Subset: `bike-parking-coverage`, `basic-category-rollup`, `bus-stops-cambridge`
(2 repeats each).

```json
{
  "c-truncated": 13,
  "B": 5,
  "A": 3,
  "c-wrong-column": 1,
  "c-unknown": 7
}
```

## AFTER

Source:

```text
experiments/runs/after-categories-truncation-hint-00bff1a/agenteval-summary.json
```

```json
{
  "c-truncated": 5,
  "B": 2,
  "c-unknown": 2,
  "A": 1
}
```

Run status:

```text
6/6 attempts run, 5 completed, cost $1.3693, 40.2 min
```

## Verdict

**Confirmed, provisionally.** On the matched three-question subset, truncation
failures fell from **13 to 5** after the CLI explicitly said the list was
truncated and named the recovery action. This is Tier 2 evidence for the design
property.

Residual risks:

- One AFTER attempt still timed out.
- This is a three-question paired subset, not the full 30-question bank.
- The metric is failure-class reduction, not yet final answer correctness.
