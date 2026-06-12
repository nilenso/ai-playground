"""BM25SparseEmbedder — sparse BM25 vectors via fastembed (`Qdrant/bm25`).

The client side emits raw term-frequency weights keyed by token id; the Qdrant
collection carries ``modifier=IDF`` on its sparse field, so the **server** folds
in inverse-document-frequency at query time using corpus-wide statistics. That's
the "server-side BM25" the slice-3 spec asks for — IDF is never frozen into the
stored vectors, so it stays correct as the corpus grows.

Output is ``{token_id: weight}`` (the core ``SparseVector`` type); the Qdrant
adapter converts that to Qdrant's ``SparseVector(indices=, values=)`` at the
boundary. Document and query use BM25's asymmetric weighting (``query_embed``).
"""

from __future__ import annotations


class BM25SparseEmbedder:
    def __init__(self, model: str = "Qdrant/bm25") -> None:
        from fastembed import SparseTextEmbedding

        self.model_name = model
        self._model = SparseTextEmbedding(model_name=model)

    @staticmethod
    def _to_dict(sparse) -> dict[int, float]:
        return {int(i): float(v) for i, v in zip(sparse.indices, sparse.values)}

    def embed_documents(self, texts: list[str]) -> list[dict[int, float]]:
        if not texts:
            return []
        return [self._to_dict(s) for s in self._model.embed(texts)]

    def embed_query(self, text: str) -> dict[int, float]:
        return self._to_dict(next(iter(self._model.query_embed(text))))
