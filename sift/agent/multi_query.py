"""MultiQueryRetriever — fan out one query into four, fuse, rerank once.

A decorator over the slice-4 ``Retriever`` (it satisfies the same
``SupportsRetrieve`` the agent depends on, so nothing in the agent loop changes).
Per call:

1. rewrite the query into 4 variants (3 paraphrases + 1 HyDE);
2. run 4 **hybrid** searches in parallel, each pulling ``candidate_k`` candidates;
3. RRF-merge the four candidate lists into one ranked pool (a chunk that several
   variants surface rises);
4. a **single** cross-encoder rerank pass against the *original* query trims the
   pool to ``k``.

It reaches the inner retriever's embedder / sparse embedder / store / reranker
only through their Protocol methods, so it stays adapter-agnostic. RRF is applied
client-side here (across variant result sets); the per-search dense+sparse fusion
still happens server-side inside ``hybrid_search``.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from core.models import RetrievedChunk
from core.retriever import Retriever
from agent.query_rewrite import rewrite_query

RRF_K = 60  # standard RRF damping constant


class MultiQueryRetriever:
    def __init__(self, inner: Retriever, *, client, max_variants: int = 4) -> None:
        self.inner = inner
        self.client = client
        self.max_variants = max_variants
        self.last_variants: list[str] = []

    def _search_one(self, variant: str, candidate_k: int) -> list[RetrievedChunk]:
        dense_q = self.inner.embedder.embed_query(variant)
        sparse_q = (
            self.inner.sparse_embedder.embed_query(variant)
            if self.inner.sparse_embedder
            else None
        )
        return self.inner.store.hybrid_search(
            dense_q=dense_q, sparse_q=sparse_q, k=candidate_k
        )

    @staticmethod
    def _rrf_merge(result_lists: list[list[RetrievedChunk]]) -> list[RetrievedChunk]:
        scores: dict[str, float] = {}
        best: dict[str, RetrievedChunk] = {}
        for hits in result_lists:
            for rank, rc in enumerate(hits):
                cid = rc.chunk.chunk_id
                scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
                if cid not in best:
                    best[cid] = rc
        ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        merged: list[RetrievedChunk] = []
        for new_rank, (cid, score) in enumerate(ordered):
            rc = best[cid]
            merged.append(
                RetrievedChunk(chunk=rc.chunk, score=score, rank=new_rank, retriever="rrf")
            )
        return merged

    def retrieve(self, query: str, k: int) -> list[RetrievedChunk]:
        variants = rewrite_query(self.client, query)[: self.max_variants]
        self.last_variants = variants
        candidate_k = self.inner.candidate_k

        with ThreadPoolExecutor(max_workers=len(variants)) as pool:
            result_lists = list(
                pool.map(lambda v: self._search_one(v, candidate_k), variants)
            )

        merged = self._rrf_merge(result_lists)[:candidate_k]

        # Single rerank pass, scored against the user's ORIGINAL question.
        if self.inner.reranker is not None:
            return self.inner.reranker.rerank(query, merged, top_n=k)
        return merged[:k]
