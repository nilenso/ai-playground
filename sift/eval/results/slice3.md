# Slice 3 — retrieval eval (hybrid)

_Generated 2026-06-10 16:54 UTC_ · corpus **609 docs / 17693 chunks** · eval **100 queries** (25/type) · embedder `BAAI/bge-small-en-v1.5` (dim 384)

## Overall (answerable queries)

| scope | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| answerable | 75 | 0.520 | 0.712 | 0.830 | 0.734 | 0.594 |

## By query type

| query type | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| inference_query | 25 | 0.420 | 0.597 | 0.717 | 0.738 | 0.517 |
| comparison_query | 25 | 0.633 | 0.800 | 0.880 | 0.781 | 0.667 |
| temporal_query | 25 | 0.507 | 0.740 | 0.893 | 0.681 | 0.598 |
| null_query | 25 | — | — | — | — | — |

> `null_query` has no gold documents (the right answer is "Insufficient information"), so retrieval recall/MRR/NDCG are undefined for it — its quality is measured on the answer side in slice 6.

## Delta vs slice 2 (dense)

| metric | prev | curr | Δ |
|---|---|---|---|
| recall@5 | 0.391 | 0.520 | +0.129 |
| recall@10 | 0.549 | 0.712 | +0.163 |
| recall@20 | 0.693 | 0.830 | +0.137 |
| mrr | 0.557 | 0.734 | +0.176 |
| ndcg@10 | 0.439 | 0.594 | +0.155 |
