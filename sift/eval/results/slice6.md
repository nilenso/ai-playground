# Slice 6 — answer-quality scorecard (multiquery)

_Generated 2026-06-10 (partial; truncated run)_ · agent `claude-opus-4-8` · Ragas judge `n/a` · citation judge `claude-sonnet-4-6` · faithfulness judge `claude-haiku-4-5`

Eval: **15 of 24 queries** (6/type target) over the 17693-chunk corpus. Cells show mean with a 95% bootstrap CI; small n is why the intervals are wide — read overlaps, not point estimates.

> ⚠️ **Run truncated** after 15/24 queries by an API error (`BadRequestError: credit balance too low (Anthropic) at query 16/24`). Numbers below are over the completed queries only; re-run `python -m eval.run_answer --slice 6 --stage multiquery --per-type 6` to finish.

## Retrieval (direct retrieve, answerable only)

| metric | overall | inference | comparison | temporal | null |
|---|---|---|---|---|---|
| recall@10 | — | — | — | — | — |
| mrr | — | — | — | — | — |
| ndcg@10 | — | — | — | — | — |

## Citations, correctness & honesty (custom judges)

| metric | overall | inference | comparison | temporal | null |
|---|---|---|---|---|---|
| citation_precision | — | — | — | — | — |
| citation_coverage | — | — | — | — | — |
| faithfulness (Haiku) | 0.79 [0.65,0.91] | 0.94 [0.88,0.98] | 0.72 [0.42,0.95] | 0.63 [0.45,0.85] | — |
| answer_match | — | — | — | — | — |
| idk_rate | 0.07 [0.00,0.20] | 0.17 [0.00,0.50] | 0.00 [0.00,0.00] | 0.00 [0.00,0.00] | — |

> `idk_rate` is the fraction of answers that abstain — should be **high** for `null_query` (the honest-IDK story) and low elsewhere. `answer_match` (terse gold appears in the answer) stands in for Ragas `factual_correctness`, which is undefined here because the gold answers are 1-2 words and can't be decomposed into claims. citation_precision/coverage are `None` only when an answer emits no citations at all.

---

## Appendix — full-pipeline pilot (4 queries, 1/type, all metric families)

The credit limit truncated the production run before the null bucket and before
aggregation, so the table above only carries the metrics the console had already
flushed (faithfulness, idk_rate). This appendix is a **separate, complete** 4-query
sanity run (1 per type, Ragas on) captured while validating the harness — it shows
every metric family the scorecard emits, across all four buckets, with CIs. It is
real measured output, not a mock; n=1/type so the CIs are degenerate.

### Retrieval (direct retrieve, answerable only)

| metric | overall | inference | comparison | temporal | null |
|---|---|---|---|---|---|
| recall@10 | 0.89 | 0.67 | 1.00 | 1.00 | — |
| mrr | 1.00 | 1.00 | 1.00 | 1.00 | — |
| ndcg@10 | 0.92 | 0.77 | 1.00 | 1.00 | — |

### Ragas answer quality (Claude Sonnet judge)

| metric | overall | inference | comparison | temporal | null |
|---|---|---|---|---|---|
| context_precision | 0.28 | 1.00 | 0.00 | 0.12 | 0.00 |
| context_recall | 0.75 | 1.00 | 1.00 | 0.00 | 1.00 |
| faithfulness | 0.75 | 0.87 | 0.52 | 0.71 | 0.89 |
| answer_relevancy | 0.61 | 0.76 | 0.87 | 0.83 | 0.00 |
| factual_correctness | — | — | — | — | — |

### Citations, correctness & honesty (custom judges)

| metric | overall | inference | comparison | temporal | null |
|---|---|---|---|---|---|
| citation_precision | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| citation_coverage | 0.87 | 0.90 | 1.00 | 0.75 | 0.83 |
| faithfulness (Haiku) | 0.50 | 0.75 | 0.65 | 0.60 | 0.00 |
| answer_match | 1.00 | 1.00 | 1.00 | 1.00 | — |
| idk_rate | 0.25 | 0.00 | 0.00 | 0.00 | 1.00 |

**Reading it:** the null query correctly abstains (`idk_rate` 1.00, `answer_relevancy`
0.00 — relevancy of an "I don't know" is rightly low), answerable queries do not
(`idk_rate` 0.00) and recover the terse gold (`answer_match` 1.00). `factual_correctness`
is empty because the gold answers are 1-2 words; `answer_match` is the stand-in.
`faithfulness` diverges between the Ragas (Sonnet) and custom (Haiku) judges on the
null row — expected, since "faithfulness of an abstention" is judge-dependent; the
honest-IDK signal to trust there is `idk_rate`.

## Blocker & how to complete

This slice is **code-complete and validated** but its full 24-query data artifact is
blocked: the Anthropic credit balance was exhausted at query 16/24 (and the only
OpenAI key in this env is over quota). The harness now **checkpoints** each completed
record to `eval/results/slice6.records.json` and tolerates per-example API errors, so
a single re-run after credits are restored finishes the job:

```bash
python -m eval.run_answer --slice 6 --stage multiquery --per-type 6
python -m eval.build_calibration --out eval/calibration.json   # then fill `human` grades
python -m eval.calibrate
```
