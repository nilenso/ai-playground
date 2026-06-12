"""RecursiveCharacterChunker — 512/64 recursive character splitting.

A self-contained implementation of the LangChain-style recursive splitter (no
extra dependency): try to split on the largest natural boundary that keeps
pieces under `chunk_size`, falling back to finer separators, then greedily merge
adjacent pieces back up to `chunk_size` with `chunk_overlap` carried between
chunks. Recursive 512/64 is the defensible default per PLAN.md.
"""

from __future__ import annotations

from core.models import Chunk, Document

DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]


class RecursiveCharacterChunker:
    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        separators: list[str] | None = None,
    ) -> None:
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be smaller than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators or DEFAULT_SEPARATORS

    def chunk(self, doc: Document) -> list[Chunk]:
        texts = self._split_text(doc.text, self.separators)
        chunks: list[Chunk] = []
        for ordinal, text in enumerate(texts):
            chunks.append(
                Chunk(
                    chunk_id=Chunk.make_id(doc.doc_id, ordinal),
                    doc_id=doc.doc_id,
                    text=text,
                    ordinal=ordinal,
                    metadata=dict(doc.metadata),
                )
            )
        return chunks

    # --- internals -------------------------------------------------------

    def _split_text(self, text: str, separators: list[str]) -> list[str]:
        # Pick the first separator that actually occurs; keep the rest for recursion.
        separator = separators[-1]
        remaining: list[str] = []
        for i, sep in enumerate(separators):
            if sep == "":
                separator = sep
                break
            if sep in text:
                separator = sep
                remaining = separators[i + 1 :]
                break

        splits = list(text) if separator == "" else text.split(separator)

        final: list[str] = []
        good_batch: list[str] = []
        merge_sep = "" if separator == "" else separator
        for piece in splits:
            if len(piece) < self.chunk_size:
                good_batch.append(piece)
            else:
                if good_batch:
                    final.extend(self._merge(good_batch, merge_sep))
                    good_batch = []
                if remaining:
                    final.extend(self._split_text(piece, remaining))
                else:
                    final.append(piece)
        if good_batch:
            final.extend(self._merge(good_batch, merge_sep))
        return [c for c in final if c.strip()]

    def _merge(self, splits: list[str], separator: str) -> list[str]:
        sep_len = len(separator)
        docs: list[str] = []
        current: list[str] = []
        total = 0
        for piece in splits:
            piece_len = len(piece)
            extra = sep_len if current else 0
            if total + piece_len + extra > self.chunk_size and current:
                docs.append(separator.join(current).strip())
                # Drop from the front until we're back under size + overlap budget.
                while current and (
                    total > self.chunk_overlap
                    or (total + piece_len + (sep_len if current else 0) > self.chunk_size)
                ):
                    total -= len(current[0]) + (sep_len if len(current) > 1 else 0)
                    current.pop(0)
            current.append(piece)
            total += piece_len + (sep_len if len(current) > 1 else 0)
        if current:
            docs.append(separator.join(current).strip())
        return [d for d in docs if d]
