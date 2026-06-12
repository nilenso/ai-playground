"""Core data model shared across the whole pipeline.

Every adapter speaks in these types; the agent imports only from `core`. The
shapes here are the contract that later slices swap organs behind — keep them
stable.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Document:
    """A source document, before chunking."""

    doc_id: str
    text: str
    metadata: dict = field(default_factory=dict)  # source, url, title, author, published_at, ...


@dataclass(frozen=True)
class Chunk:
    """A retrievable slice of a document.

    `chunk_id` is stable and reconstructable: ``f"{doc_id}::{ordinal}"``. It is
    the thread that ties retrieval → vector-store payload → the document block in
    the message → the citation span → the gold set in eval. Any layer that drops
    it breaks citation tracking.
    """

    chunk_id: str  # stable: f"{doc_id}::{ordinal}"
    doc_id: str
    text: str
    ordinal: int
    metadata: dict = field(default_factory=dict)

    @staticmethod
    def make_id(doc_id: str, ordinal: int) -> str:
        return f"{doc_id}::{ordinal}"


@dataclass(frozen=True)
class RetrievedChunk:
    """A chunk surfaced by retrieval, with provenance about how it got here."""

    chunk: Chunk
    score: float
    rank: int
    retriever: str  # "dense" | "sparse" | "rrf" | "rerank"


@dataclass(frozen=True)
class Citation:
    """A structured citation parsed from the Anthropic Citations API.

    For search-result citations the API hands back ``source``/``title``/
    ``cited_text`` plus block indices. We carry ``chunk_id`` (== the source we
    fed in) so a citation resolves straight back to a real chunk in the corpus.
    """

    cited_text: str
    chunk_id: str | None
    doc_id: str | None
    title: str | None
    search_result_index: int | None = None
    start_block_index: int | None = None
    end_block_index: int | None = None


@dataclass(frozen=True)
class EvalExample:
    """One labelled question with its gold evidence.

    `gold_doc_ids` is what retrieval metrics score against; `evidence` holds the
    gold fact snippets for answer/citation judging in later slices.
    """

    query: str
    answer: str
    question_type: str  # inference_query | comparison_query | temporal_query | null_query
    gold_doc_ids: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()
