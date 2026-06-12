"""Reranker Protocol — re-score a candidate set against the query.

No implementation yet (slice 4 brings the bge cross-encoder). Defined now so the
`Retriever` can compose an optional reranker without a later interface change.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.models import RetrievedChunk


@runtime_checkable
class Reranker(Protocol):
    def rerank(
        self, query: str, candidates: list[RetrievedChunk], top_n: int
    ) -> list[RetrievedChunk]: ...
