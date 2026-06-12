# Slice 5 — retrieval eval (multiquery)

_Generated 2026-06-10 17:17 UTC_ · corpus **609 docs / 17693 chunks** · eval **100 queries** (25/type) · embedder `BAAI/bge-small-en-v1.5` (dim 384)

## Overall (answerable queries)

| scope | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| answerable | 75 | 0.616 | 0.756 | 0.874 | 0.811 | 0.682 |

## By query type

| query type | n | recall@5 | recall@10 | recall@20 | mrr | ndcg@10 |
|---|---|---|---|---|---|---|
| inference_query | 25 | 0.487 | 0.593 | 0.737 | 0.807 | 0.570 |
| comparison_query | 25 | 0.780 | 0.880 | 0.980 | 0.873 | 0.807 |
| temporal_query | 25 | 0.580 | 0.793 | 0.907 | 0.752 | 0.669 |
| null_query | 25 | — | — | — | — | — |

> `null_query` has no gold documents (the right answer is "Insufficient information"), so retrieval recall/MRR/NDCG are undefined for it — its quality is measured on the answer side in slice 6.

## Reranker latency (`BAAI/bge-reranker-v2-m3`)

Per-query cross-encoder scoring over 50 candidates (n=100): **median 2372 ms**, **p95 4182 ms** (mps).

## Delta vs slice 4 (rerank)

| metric | prev | curr | Δ |
|---|---|---|---|
| recall@5 | 0.631 | 0.616 | -0.016 |
| recall@10 | 0.746 | 0.756 | +0.010 |
| recall@20 | 0.898 | 0.874 | -0.023 |
| mrr | 0.793 | 0.811 | +0.018 |
| ndcg@10 | 0.675 | 0.682 | +0.007 |
