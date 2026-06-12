"""JsonFixtureSource — load a MultiHopRAG-shaped corpus from a JSON fixture.

This was the slice-1 ``HFDatasetSource``: it reads a small hand-authored JSON
file (documents + eval examples) so the walking skeleton and the offline tests
run with no network and no HuggingFace download. Slice 2 introduces the real
``HFDatasetSource`` (streams ``yixuantt/MultiHopRAG``); this stays for the $0,
offline path behind the same ``DataSource`` Protocol.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from core.models import Document, EvalExample


class JsonFixtureSource:
    def __init__(self, fixture_path: str | Path) -> None:
        self.fixture_path = Path(fixture_path)
        with self.fixture_path.open(encoding="utf-8") as f:
            self._data = json.load(f)

    def iter_documents(self) -> Iterator[Document]:
        for raw in self._data["documents"]:
            yield Document(
                doc_id=raw["doc_id"],
                text=raw["body"],
                metadata={
                    "title": raw.get("title", ""),
                    "source": raw.get("source", ""),
                    "url": raw.get("url", ""),
                    "published_at": raw.get("published_at", ""),
                    "category": raw.get("category", ""),
                    "author": raw.get("author", ""),
                },
            )

    def get_eval_set(self) -> list[EvalExample]:
        examples: list[EvalExample] = []
        for raw in self._data.get("eval", []):
            examples.append(
                EvalExample(
                    query=raw["query"],
                    answer=raw["answer"],
                    question_type=raw.get("question_type", "inference_query"),
                    gold_doc_ids=tuple(raw.get("gold_doc_ids", [])),
                    evidence=tuple(raw.get("evidence", [])),
                )
            )
        return examples
