"""DataSource Protocol — where documents and eval sets come from.

Swapping the dataset (MultiHopRAG → FinanceBench in slice 6) is a new adapter
behind this Protocol; nothing downstream changes.
"""

from __future__ import annotations

from typing import Iterator, Protocol, runtime_checkable

from core.models import Document, EvalExample


@runtime_checkable
class DataSource(Protocol):
    def iter_documents(self) -> Iterator[Document]: ...

    def get_eval_set(self) -> list[EvalExample]: ...
