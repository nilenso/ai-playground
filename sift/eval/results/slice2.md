# Slice 2 — retrieval eval (dense)

_Generated 2026-06-10 16:53 UTC_ · corpus **609 docs / 17693 chunks** · eval **100 queries** (25/type) · embedder `BAAI/bge-small-en-v1.5` (dim 384)

## Overall (answerable queries)

| scope | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| answerable | 75 | 0.391 | 0.549 | 0.693 | 0.557 | 0.439 |

## By query type

| query type | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| inference_query | 25 | 0.260 | 0.433 | 0.600 | 0.477 | 0.342 |
| comparison_query | 25 | 0.440 | 0.520 | 0.707 | 0.561 | 0.446 |
| temporal_query | 25 | 0.473 | 0.693 | 0.773 | 0.634 | 0.529 |
| null_query | 25 | — | — | — | — | — |

> `null_query` has no gold documents (the right answer is "Insufficient information"), so retrieval recall/MRR/NDCG are undefined for it — its quality is measured on the answer side in slice 6.
