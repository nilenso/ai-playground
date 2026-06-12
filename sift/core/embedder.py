"""Embedder Protocol — text → dense vectors.

`dim` lets the vector store size its collection without a probe embedding.
Document and query embeddings are separate methods because retrieval-tuned
models like BGE ask for an input-type hint that differs between the two.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Embedder(Protocol):
    dim: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...
