"""QdrantVectorStore — persistent, idempotent, dense + (optional) sparse hybrid.

Evolution of the slice-1 store, behind the same ``VectorStore`` Protocol:

* **Persistent** — ``location`` is a path (``./qdrant_db``) for an on-disk
  collection, or ``":memory:"`` for the ephemeral slice-1 / test path.
* **Named dense vector** ``"dense"`` from the start, so slice 3 only *adds* a
  named sparse field rather than reshaping the schema.
* **Idempotent indexing** — point ids are ``uuid5(chunk_id)``, so re-running the
  indexer is a no-op for already-present chunks. ``new_chunks`` filters to the
  chunks that still need embedding, satisfying "re-running indexing does not
  re-embed already-present chunks".
* **Hybrid** (``hybrid=True``, slice 3) — a named sparse vector ``"bm25"`` with
  ``modifier=IDF`` (server-side BM25). ``hybrid_search`` then issues a *single*
  Query API call: two ``Prefetch`` blocks (dense + sparse) fused with
  ``FusionQuery(fusion=RRF)``. With ``hybrid=False`` it is a plain dense search.

Switching ``hybrid`` changes the collection schema, so the indexer recreates the
collection (documented in the slice-3 notes); embeddings are cheap to recompute.
"""

from __future__ import annotations

import uuid
from typing import Any

from core.models import Chunk, RetrievedChunk
from core.vectorstore import SparseVector

# Stable namespace so uuid5(chunk_id) is identical across runs/processes.
_NS = uuid.UUID("6f9b1c2e-0d4a-4e7b-9c3d-1a2b3c4d5e6f")

DENSE = "dense"
BM25 = "bm25"


def _point_id(chunk_id: str) -> str:
    return str(uuid.uuid5(_NS, chunk_id))


class QdrantVectorStore:
    def __init__(
        self,
        dim: int,
        collection: str = "knowledge_base",
        location: str = ":memory:",
        *,
        hybrid: bool = False,
        recreate: bool = False,
    ) -> None:
        from qdrant_client import QdrantClient
        from qdrant_client.models import (
            Distance,
            Modifier,
            SparseVectorParams,
            VectorParams,
        )

        self.collection = collection
        self.dim = dim
        self.hybrid = hybrid
        self._client = (
            QdrantClient(location=":memory:")
            if location == ":memory:"
            else QdrantClient(path=location)
        )

        exists = self._client.collection_exists(collection)
        if exists and recreate:
            self._client.delete_collection(collection)
            exists = False
        if not exists:
            sparse_cfg = (
                {BM25: SparseVectorParams(modifier=Modifier.IDF)} if hybrid else None
            )
            self._client.create_collection(
                collection_name=collection,
                vectors_config={DENSE: VectorParams(size=dim, distance=Distance.COSINE)},
                sparse_vectors_config=sparse_cfg,
            )

    # --- indexing --------------------------------------------------------

    def count(self) -> int:
        return self._client.count(self.collection, exact=True).count

    def new_chunks(self, chunks: list[Chunk]) -> list[Chunk]:
        """Chunks not already stored — so the caller only embeds what's missing."""
        if not chunks:
            return []
        ids = [_point_id(c.chunk_id) for c in chunks]
        found = self._client.retrieve(self.collection, ids=ids, with_payload=False)
        present = {str(p.id) for p in found}
        return [c for c, pid in zip(chunks, ids) if pid not in present]

    def upsert(
        self,
        chunks: list[Chunk],
        dense: list[list[float]],
        sparse: list[SparseVector] | None = None,
    ) -> None:
        from qdrant_client.models import PointStruct
        from qdrant_client.models import SparseVector as QSparse

        if len(chunks) != len(dense):
            raise ValueError("chunks and dense vectors must be the same length")
        if sparse is not None and len(sparse) != len(chunks):
            raise ValueError("sparse vectors must align with chunks")

        points = []
        for i, (chunk, vector) in enumerate(zip(chunks, dense)):
            vectors: dict[str, Any] = {DENSE: vector}
            if self.hybrid and sparse is not None:
                sv = sparse[i]
                vectors[BM25] = QSparse(
                    indices=list(sv.keys()), values=list(sv.values())
                )
            points.append(
                PointStruct(
                    id=_point_id(chunk.chunk_id),
                    vector=vectors,
                    payload={
                        "chunk_id": chunk.chunk_id,
                        "doc_id": chunk.doc_id,
                        "text": chunk.text,
                        "ordinal": chunk.ordinal,
                        "metadata": chunk.metadata,
                    },
                )
            )
        if points:
            self._client.upsert(collection_name=self.collection, points=points)

    # --- retrieval -------------------------------------------------------

    def hybrid_search(
        self,
        dense_q: list[float],
        sparse_q: SparseVector | None = None,
        k: int = 10,
        filters: dict[str, Any] | None = None,  # noqa: ARG002 - reserved
    ) -> list[RetrievedChunk]:
        if self.hybrid and sparse_q is not None:
            return self._fused_search(dense_q, sparse_q, k)
        hits = self._client.query_points(
            collection_name=self.collection,
            query=dense_q,
            using=DENSE,
            limit=k,
            with_payload=True,
        ).points
        return self._to_chunks(hits, retriever="dense")

    def _fused_search(
        self, dense_q: list[float], sparse_q: SparseVector, k: int
    ) -> list[RetrievedChunk]:
        from qdrant_client.models import (
            Fusion,
            FusionQuery,
            Prefetch,
        )
        from qdrant_client.models import SparseVector as QSparse

        # Prefetch a wider pool per modality than k, then fuse — RRF over the
        # tails is where hybrid earns its recall.
        prefetch_limit = max(k * 2, 50)
        result = self._client.query_points(
            collection_name=self.collection,
            prefetch=[
                Prefetch(query=dense_q, using=DENSE, limit=prefetch_limit),
                Prefetch(
                    query=QSparse(
                        indices=list(sparse_q.keys()), values=list(sparse_q.values())
                    ),
                    using=BM25,
                    limit=prefetch_limit,
                ),
            ],
            query=FusionQuery(fusion=Fusion.RRF),
            limit=k,
            with_payload=True,
        )
        return self._to_chunks(result.points, retriever="rrf")

    def _to_chunks(self, hits, retriever: str) -> list[RetrievedChunk]:
        results: list[RetrievedChunk] = []
        for rank, hit in enumerate(hits):
            payload = hit.payload or {}
            chunk = Chunk(
                chunk_id=payload["chunk_id"],
                doc_id=payload["doc_id"],
                text=payload["text"],
                ordinal=payload["ordinal"],
                metadata=payload.get("metadata", {}),
            )
            results.append(
                RetrievedChunk(
                    chunk=chunk, score=hit.score, rank=rank, retriever=retriever
                )
            )
        return results
