# Slice 4 — retrieval eval (rerank)

_Generated 2026-06-10 17:00 UTC_ · corpus **609 docs / 17693 chunks** · eval **100 queries** (25/type) · embedder `BAAI/bge-small-en-v1.5` (dim 384)

## Overall (answerable queries)

| scope | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| answerable | 75 | 0.631 | 0.746 | 0.898 | 0.793 | 0.675 |

## By query type

| query type | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| inference_query | 25 | 0.533 | 0.637 | 0.827 | 0.830 | 0.607 |
| comparison_query | 25 | 0.780 | 0.840 | 0.960 | 0.852 | 0.783 |
| temporal_query | 25 | 0.580 | 0.760 | 0.907 | 0.698 | 0.635 |
| null_query | 25 | — | — | — | — | — |

> `null_query` has no gold documents (the right answer is "Insufficient information"), so retrieval recall/MRR/NDCG are undefined for it — its quality is measured on the answer side in slice 6.

## Reranker latency (`BAAI/bge-reranker-v2-m3`)

Per-query cross-encoder scoring over 50 candidates (n=100): **median 2241 ms**, **p95 3402 ms** (mps).

## Delta vs slice 3 (hybrid)

| metric | prev | curr | Δ |
|---|---|---|---|
| recall@5 | 0.520 | 0.631 | +0.111 |
| recall@10 | 0.712 | 0.746 | +0.033 |
| recall@20 | 0.830 | 0.898 | +0.068 |
| mrr | 0.734 | 0.793 | +0.060 |
| ndcg@10 | 0.594 | 0.675 | +0.081 |
