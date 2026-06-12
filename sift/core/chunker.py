"""Chunker Protocol — how a Document becomes a list of retrievable Chunks."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.models import Chunk, Document


@runtime_checkable
class Chunker(Protocol):
    def chunk(self, doc: Document) -> list[Chunk]: ...
