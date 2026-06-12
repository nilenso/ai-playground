"""BGEEmbedder — open embedder via fastembed (ONNX).

The project's only embedder. BGE-M3 is a ~2GB download; we default to the small,
fast `bge-small-en-v1.5` so the demo runs in seconds. Swapping to
BGE-M3 is one model string (set BGE_MODEL=BAAI/bge-m3) — the whole point of the
Embedder Protocol.
"""

from __future__ import annotations

import os


class BGEEmbedder:
    def __init__(self, model: str | None = None) -> None:
        from fastembed import TextEmbedding  # lazy: only needed on the fallback path

        self.model_name = model or os.getenv("BGE_MODEL", "BAAI/bge-small-en-v1.5")
        self._model = TextEmbedding(model_name=self.model_name)
        # Probe once to learn the embedding dimension without hardcoding a table.
        self.dim = len(next(iter(self._model.embed(["dimension probe"]))))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return [vec.tolist() for vec in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        # fastembed exposes query_embed for retrieval models; fall back to embed.
        query_embed = getattr(self._model, "query_embed", None)
        if query_embed is not None:
            return next(iter(query_embed(text))).tolist()
        return next(iter(self._model.embed([text]))).tolist()
