"""Retriever — composes an Embedder, a VectorStore and an optional Reranker.

Lives in `core` and depends only on `core` Protocols; the app injects concrete
adapters and the agent only ever sees a ``SupportsRetrieve``. One ``retrieve``
covers every slice's pipeline:

* dense-only (slice 2): no sparse embedder, no reranker → one dense search.
* hybrid (slice 3): a sparse embedder is injected, so the query is embedded both
  ways and ``hybrid_search`` fuses them server-side with RRF.
* rerank (slice 4): a reranker is injected, so we fetch a wider ``candidate_k``
  pool and the reranker trims it back to ``k``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.embedder import Embedder
from core.models import RetrievedChunk
from core.reranker import Reranker
from core.vectorstore import VectorStore


@runtime_checkable
class SupportsRetrieve(Protocol):
    """What the agent depends on — just `retrieve`."""

    def retrieve(self, query: str, k: int) -> list[RetrievedChunk]: ...


@runtime_checkable
class SparseEmbedder(Protocol):
    """Text → sparse {token_id: weight} vectors (BM25-style), slice 3+."""

    def embed_query(self, text: str) -> dict[int, float]: ...

    def embed_documents(self, texts: list[str]) -> list[dict[int, float]]: ...


class Retriever:
    def __init__(
        self,
        embedder: Embedder,
        store: VectorStore,
        reranker: Reranker | None = None,
        *,
        sparse_embedder: SparseEmbedder | None = None,
        candidate_k: int = 50,
    ) -> None:
        self.embedder = embedder
        self.store = store
        self.reranker = reranker
        self.sparse_embedder = sparse_embedder
        self.candidate_k = candidate_k

    def retrieve(self, query: str, k: int) -> list[RetrievedChunk]:
        dense_q = self.embedder.embed_query(query)
        sparse_q = (
            self.sparse_embedder.embed_query(query) if self.sparse_embedder else None
        )
        # Pull a wider candidate set only when a reranker will trim it back.
        fetch_k = self.candidate_k if self.reranker else k
        results = self.store.hybrid_search(dense_q=dense_q, sparse_q=sparse_q, k=fetch_k)
        if self.reranker:
            results = self.reranker.rerank(query, results, top_n=k)
        return results[:k]
