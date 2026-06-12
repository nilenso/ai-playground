"""Core contracts: dataclasses + Protocols that every other layer speaks.

Re-exported here so callers can ``from core import Document, Retriever, ...``.
"""

from core.chunker import Chunker
from core.datasource import DataSource
from core.embedder import Embedder
from core.models import Chunk, Citation, Document, EvalExample, RetrievedChunk
from core.reranker import Reranker
from core.retriever import Retriever, SparseEmbedder, SupportsRetrieve
from core.vectorstore import SparseVector, VectorStore

__all__ = [
    "Chunk",
    "Chunker",
    "Citation",
    "DataSource",
    "Document",
    "Embedder",
    "EvalExample",
    "Reranker",
    "RetrievedChunk",
    "Retriever",
    "SparseEmbedder",
    "SparseVector",
    "SupportsRetrieve",
    "VectorStore",
]
