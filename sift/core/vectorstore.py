"""VectorStore Protocol — upsert chunk vectors, retrieve by similarity.

The signature carries `sparse` and `hybrid_search` from day one even though
slice 1 is dense-only (callers pass ``sparse=None`` / ``sparse_q=None``). Slice 3
fills in the sparse + RRF path behind the same interface.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from core.models import Chunk, RetrievedChunk

# A sparse vector as {token_id: weight}; None until slice 3 adds BM25.
SparseVector = dict[int, float]


@runtime_checkable
class VectorStore(Protocol):
    def upsert(
        self,
        chunks: list[Chunk],
        dense: list[list[float]],
        sparse: list[SparseVector] | None = None,
    ) -> None: ...

    def hybrid_search(
        self,
        dense_q: list[float],
        sparse_q: SparseVector | None = None,
        k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[RetrievedChunk]: ...
