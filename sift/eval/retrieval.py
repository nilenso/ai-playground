"""Deterministic, doc-level retrieval metrics: recall@k, MRR, NDCG@k.

Retrieval returns *chunks*; gold is at the *document* level. So the window is
always the top-k **chunks**, and a gold document is credited the first time any
of its chunks appears in that window (several chunks of one gold doc collapse to
a single hit — never double credit, and never rank-compression from de-duping
before truncating).

Null queries (``null_query``) have an **empty gold set** by construction — the
right behaviour is to retrieve nothing useful and abstain. Recall / MRR / NDCG
are undefined over an empty gold set (0/0), so :func:`per_query_metrics` returns
``None`` for those, and the aggregator reports null_query on the answer side
(slice 6) rather than faking a retrieval number.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from core.models import RetrievedChunk


def _first_gold_positions(
    retrieved: Sequence[RetrievedChunk], gold: set[str], k: int
) -> list[int]:
    """1-based chunk positions where each gold doc *first* appears within top-k."""
    seen: set[str] = set()
    positions: list[int] = []
    for i, rc in enumerate(retrieved[:k], start=1):
        doc_id = rc.chunk.doc_id
        if doc_id in gold and doc_id not in seen:
            seen.add(doc_id)
            positions.append(i)
    return positions


def recall_at_k(
    retrieved: Sequence[RetrievedChunk], gold_doc_ids: Sequence[str], k: int
) -> float:
    gold = set(gold_doc_ids)
    if not gold:
        return 0.0
    found = {rc.chunk.doc_id for rc in retrieved[:k]} & gold
    return len(found) / len(gold)


def mrr(retrieved: Sequence[RetrievedChunk], gold_doc_ids: Sequence[str]) -> float:
    """Reciprocal rank (over chunks) of the first chunk from any gold doc."""
    gold = set(gold_doc_ids)
    if not gold:
        return 0.0
    for i, rc in enumerate(retrieved, start=1):
        if rc.chunk.doc_id in gold:
            return 1.0 / i
    return 0.0


def ndcg_at_k(
    retrieved: Sequence[RetrievedChunk], gold_doc_ids: Sequence[str], k: int
) -> float:
    """Binary-relevance NDCG@k; each gold doc credited once at its first chunk."""
    gold = set(gold_doc_ids)
    if not gold:
        return 0.0
    dcg = sum(1.0 / math.log2(p + 1) for p in _first_gold_positions(retrieved, gold, k))
    ideal_hits = min(len(gold), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, ideal_hits + 1))
    return dcg / idcg if idcg else 0.0


def per_query_metrics(
    retrieved: Sequence[RetrievedChunk],
    gold_doc_ids: Sequence[str],
    ks: Sequence[int] = (5, 10, 20),
) -> dict[str, float] | None:
    """All retrieval metrics for one query, or ``None`` if the gold set is empty."""
    if not gold_doc_ids:
        return None
    out: dict[str, float] = {f"recall@{k}": recall_at_k(retrieved, gold_doc_ids, k) for k in ks}
    out["mrr"] = mrr(retrieved, gold_doc_ids)
    out["ndcg@10"] = ndcg_at_k(retrieved, gold_doc_ids, 10)
    return out
