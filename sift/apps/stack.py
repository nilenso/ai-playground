"""Composition root — the one place concrete adapters are named and wired.

`index` (build the corpus index), `eval.run_retrieval` (score it), and
`multihop_rag` (answer one question) all build their stack here, so they can
never drift out of sync. The retrieval *stage* selects how much of the pipeline
is wired:

    dense       slice 2 — dense-only Qdrant
    hybrid      slice 3 — dense + sparse BM25, fused with RRF
    rerank      slice 4 — hybrid candidates → cross-encoder rerank
    multiquery  slice 5 — Haiku query rewrite + HyDE over the rerank pipeline

Everything above ``core`` is injected; the agent only ever sees a ``Retriever``.
"""

from __future__ import annotations

from dataclasses import dataclass

from adapters.chunkers.recursive import RecursiveCharacterChunker
from adapters.sources.hf import HFDatasetSource
from adapters.vectorstores.qdrant import QdrantVectorStore
from core.datasource import DataSource
from core.retriever import Retriever

STAGES = ("dense", "hybrid", "rerank", "multiquery")

DEFAULT_PERSIST_DIR = "./qdrant_db"
COLLECTION = "knowledge_base"
CHUNK_SIZE = 512
CHUNK_OVERLAP = 64
CANDIDATE_K = 50  # hybrid pool handed to the reranker (slice 4)
RERANK_TOP_N = 8  # reranker output handed to the agent (slice 4)


def _stage_is_hybrid(stage: str) -> bool:
    return stage in ("hybrid", "rerank", "multiquery")


def _stage_has_reranker(stage: str) -> bool:
    return stage in ("rerank", "multiquery")


def build_embedder():
    """Open BGE embedder via fastembed, running locally."""
    from adapters.embedders.bge import BGEEmbedder

    emb = BGEEmbedder()
    return emb, emb.model_name


def build_source(limit: int | None = None) -> DataSource:
    return HFDatasetSource(limit=limit)


def build_store(
    dim: int,
    *,
    stage: str = "dense",
    persist_dir: str | None = DEFAULT_PERSIST_DIR,
    recreate: bool = False,
) -> QdrantVectorStore:
    location = persist_dir or ":memory:"
    return QdrantVectorStore(
        dim=dim,
        collection=COLLECTION,
        location=location,
        hybrid=_stage_is_hybrid(stage),
        recreate=recreate,
    )


@dataclass
class IndexStats:
    documents: int
    chunks: int
    embedded: int  # how many were actually (re-)embedded this run
    skipped: int  # already present — not re-embedded
    embedder: str
    dim: int


def index_corpus(
    source: DataSource,
    embedder,
    store: QdrantVectorStore,
    *,
    chunker: RecursiveCharacterChunker | None = None,
    sparse_embedder=None,
    batch_size: int = 256,
) -> IndexStats:
    """Chunk → embed → upsert, embedding only chunks not already stored.

    Idempotent: re-running over an unchanged corpus embeds nothing. When the
    store is hybrid, ``sparse_embedder`` must be supplied so each chunk also gets
    its BM25 sparse vector.
    """
    chunker = chunker or RecursiveCharacterChunker(CHUNK_SIZE, CHUNK_OVERLAP)
    docs = list(source.iter_documents())
    all_chunks = [c for doc in docs for c in chunker.chunk(doc)]

    todo = store.new_chunks(all_chunks)
    skipped = len(all_chunks) - len(todo)

    for start in range(0, len(todo), batch_size):
        batch = todo[start : start + batch_size]
        texts = [c.text for c in batch]
        dense = embedder.embed_documents(texts)
        sparse = sparse_embedder.embed_documents(texts) if sparse_embedder else None
        store.upsert(batch, dense, sparse)

    name = getattr(embedder, "model", None) or getattr(embedder, "model_name", "?")
    return IndexStats(
        documents=len(docs),
        chunks=len(all_chunks),
        embedded=len(todo),
        skipped=skipped,
        embedder=name,
        dim=embedder.dim,
    )


def build_sparse_embedder():
    """BM25 sparse embedder (fastembed Qdrant/bm25) — slice 3+. Lazy import."""
    from adapters.embedders.bm25 import BM25SparseEmbedder

    return BM25SparseEmbedder()


def build_reranker():
    """Cross-encoder reranker (bge-reranker-v2-m3) — slice 4+. Lazy import."""
    from adapters.rerankers.bge_cross import BGECrossEncoderReranker

    return BGECrossEncoderReranker()


def build_retriever(
    stage: str,
    embedder,
    store: QdrantVectorStore,
    *,
    client=None,
):
    """Assemble the retriever for a stage, building stage-specific adapters
    lazily so a dense/hybrid run never imports the reranker (and its torch)."""
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage!r}; expected one of {STAGES}")

    sparse_embedder = build_sparse_embedder() if _stage_is_hybrid(stage) else None
    reranker = build_reranker() if _stage_has_reranker(stage) else None

    retriever = Retriever(
        embedder,
        store,
        reranker=reranker,
        sparse_embedder=sparse_embedder,
        candidate_k=CANDIDATE_K,
    )

    if stage == "multiquery":
        from agent.multi_query import MultiQueryRetriever

        if client is None:
            raise ValueError("multiquery stage needs an Anthropic client for the rewriter")
        return MultiQueryRetriever(retriever, client=client)
    return retriever
