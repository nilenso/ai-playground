# Paired experiment — count wrong-column hint

Property: **If a value exists elsewhere, say where.**

Lever: **tool**

Candidate commit in botmap clone:

```text
/Users/priyangapkini/workspace/ar-b/botmap @ 7c794ff Hint when count filter uses class and subtype wrong
```

Change: when `botmap count` returns zero for `class=X` or `subtype=X`, it tests
the paired field on the same type/bbox. If the paired field returns rows, stderr
names the correction:

```text
[botmap] 0 rows for subtype='bicycle_parking', but class='bicycle_parking'
returns 1,844. Try `--where class=bicycle_parking` before concluding none exist.
```

## BEFORE

Source:

```text
experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
```

Subset: `bike-parking-coverage`, `residential-share-cambridge` (2 repeats each).

```json
{
  "c-truncated": 5,
  "B": 3,
  "c-wrong-column": 2,
  "c-unknown": 6,
  "A": 1,
  "c-wrong-type": 1
}
```

## AFTER

Source:

```text
experiments/runs/after-count-wrong-column-hint-7c794ff/agenteval-summary.json
```

```json
{
  "c-truncated": 3,
  "B": 2,
  "c-vocabulary": 2,
  "A": 1
}
```

Run status:

```text
4/4 attempts run, 3 completed, cost $0.7439, 33.0 min
```

## Verdict

**Confirmed narrowly.** On the matched two-question subset, `c-wrong-column`
fell from **2 to 0**. The broader task still has other failures, so this confirms
only the property that the CLI should name the correct field when the value is
present elsewhere.
