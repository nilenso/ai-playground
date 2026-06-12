"""BGECrossEncoderReranker — cross-encoder reranking with bge-reranker-v2-m3.

A bi-encoder (the embedder) scores query and chunk *independently*; a
cross-encoder reads the (query, chunk) pair **together**, so it resolves the
relevance distinctions that dominate precision-at-top — which is what citation
quality rides on (PLAN.md learning #4: the single highest-ROI step).

``BAAI/bge-reranker-v2-m3`` (Apache-2.0, ~568M params) is run via
``sentence_transformers.CrossEncoder``. ``rerank`` scores every candidate, keeps
the top ``top_n``, and re-stamps each survivor with ``retriever="rerank"``, its
new rank, and the cross-encoder score — while preserving ``chunk_id`` so
citations still resolve. Per-call latency is recorded in ``latencies_ms`` so the
eval can report median/p95.
"""

from __future__ import annotations

import os
import time

from core.models import RetrievedChunk

DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3"


class BGECrossEncoderReranker:
    def __init__(
        self,
        model: str | None = None,
        *,
        device: str | None = None,
        batch_size: int = 32,
        max_length: int = 512,
    ) -> None:
        from sentence_transformers import CrossEncoder

        self.model_name = model or os.getenv("RERANK_MODEL", DEFAULT_MODEL)
        self.batch_size = batch_size
        if device is None:
            # Prefer Apple Metal when present — same scores, far faster than CPU.
            try:
                import torch

                if torch.backends.mps.is_available():
                    device = "mps"
            except Exception:
                device = None
        self.device = device
        self._model = CrossEncoder(self.model_name, max_length=max_length, device=device)
        self.latencies_ms: list[float] = []

    def rerank(
        self, query: str, candidates: list[RetrievedChunk], top_n: int
    ) -> list[RetrievedChunk]:
        if not candidates:
            return []
        pairs = [[query, rc.chunk.text] for rc in candidates]

        t0 = time.perf_counter()
        scores = self._model.predict(
            pairs, batch_size=self.batch_size, show_progress_bar=False
        )
        self.latencies_ms.append((time.perf_counter() - t0) * 1000.0)

        ranked = sorted(zip(candidates, scores), key=lambda x: float(x[1]), reverse=True)
        out: list[RetrievedChunk] = []
        for new_rank, (rc, score) in enumerate(ranked[:top_n]):
            out.append(
                RetrievedChunk(
                    chunk=rc.chunk,
                    score=float(score),
                    rank=new_rank,
                    retriever="rerank",
                )
            )
        return out
