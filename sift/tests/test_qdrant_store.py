"""Store-level tests for QdrantVectorStore — in-memory, no network, no file lock.

Covers the two behaviours later slices lean on: idempotent indexing (slice 2) and
the dense + sparse → RRF fused path (slice 3).
"""

from __future__ import annotations

from core.models import Chunk
from adapters.vectorstores.qdrant import QdrantVectorStore


def _chunks(n: int) -> list[Chunk]:
    return [
        Chunk(chunk_id=Chunk.make_id("doc", i), doc_id="doc", text=f"text {i}", ordinal=i)
        for i in range(n)
    ]


def _dense(n: int, dim: int = 4) -> list[list[float]]:
    # one-hot-ish vectors so nearest-neighbour is predictable
    return [[1.0 if j == i % dim else 0.0 for j in range(dim)] for i in range(n)]


def test_dense_idempotent_indexing():
    store = QdrantVectorStore(dim=4, collection="t", location=":memory:")
    chunks = _chunks(5)
    assert len(store.new_chunks(chunks)) == 5  # nothing stored yet
    store.upsert(chunks, _dense(5))
    assert store.count() == 5
    assert store.new_chunks(chunks) == []  # all present → re-index is a no-op

    hits = store.hybrid_search(dense_q=[1.0, 0.0, 0.0, 0.0], k=3)
    assert len(hits) == 3
    assert all(h.retriever == "dense" for h in hits)
    assert hits[0].chunk.chunk_id.startswith("doc::")


def test_hybrid_fused_search():
    store = QdrantVectorStore(dim=4, collection="t", location=":memory:", hybrid=True)
    chunks = _chunks(4)
    sparse = [{1: 1.0, 2: 0.5}, {2: 1.0}, {1: 0.2, 3: 1.0}, {3: 0.3}]
    store.upsert(chunks, _dense(4), sparse)
    assert store.count() == 4

    hits = store.hybrid_search(dense_q=[1.0, 0.0, 0.0, 0.0], sparse_q={1: 1.0, 2: 1.0}, k=4)
    assert len(hits) >= 1
    assert all(h.retriever == "rrf" for h in hits)  # fused, not single-modality
    # ranks are contiguous from 0
    assert [h.rank for h in hits] == list(range(len(hits)))
