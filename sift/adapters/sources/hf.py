"""HFDatasetSource — stream the real MultiHopRAG corpus + eval set from HuggingFace.

``yixuantt/MultiHopRAG`` ships two configs:

* ``corpus`` (609 news articles) — ``body``/``title``/``url``/``source``/...,
  but **no document id**. We assign a stable ``doc_id`` in corpus order
  (``doc_0000``…) and remember the ``url``/``title`` → ``doc_id`` maps.
* ``MultiHopRAG`` (2,556 queries) — each query carries ``question_type`` and an
  ``evidence_list`` of ``{title, url, fact, ...}`` entries naming the source
  articles. We resolve those to ``gold_doc_ids`` via the url map (title as
  fallback). ``null_query`` rows have an empty ``evidence_list`` and answer
  "Insufficient information." → empty gold set, which is exactly what the
  "Honest I don't know" story should score against.

Verified once at build time: all 6,084 evidence entries resolve by both url and
title, so gold-doc resolution is exact, not lossy.

This is the slice-2 swap promised in slice 1: same ``DataSource`` Protocol, real
corpus behind it. The agent and everything downstream are untouched.
"""

from __future__ import annotations

from typing import Iterator

from core.models import Document, EvalExample

DATASET = "yixuantt/MultiHopRAG"


class HFDatasetSource:
    def __init__(
        self,
        dataset: str = DATASET,
        *,
        limit: int | None = None,
        cache_dir: str | None = None,
    ) -> None:
        from datasets import load_dataset

        self.dataset = dataset
        self.limit = limit

        corpus = load_dataset(dataset, "corpus", split="train", cache_dir=cache_dir)
        self._queries = load_dataset(
            dataset, "MultiHopRAG", split="train", cache_dir=cache_dir
        )

        # Assign stable ids in corpus order; remember how to find a doc from the
        # url/title that an evidence entry names.
        self._docs: list[Document] = []
        self._by_url: dict[str, str] = {}
        self._by_title: dict[str, str] = {}
        for i, row in enumerate(corpus):
            doc_id = f"doc_{i:04d}"
            url = (row.get("url") or "").strip()
            title = (row.get("title") or "").strip()
            self._docs.append(
                Document(
                    doc_id=doc_id,
                    text=row.get("body") or "",
                    metadata={
                        "title": title,
                        "source": row.get("source") or "",
                        "url": url,
                        "published_at": str(row.get("published_at") or ""),
                        "category": row.get("category") or "",
                        "author": row.get("author") or "",
                    },
                )
            )
            if url:
                self._by_url[url] = doc_id
            if title:
                self._by_title[title] = doc_id

    def iter_documents(self) -> Iterator[Document]:
        docs = self._docs if self.limit is None else self._docs[: self.limit]
        yield from docs

    def _resolve(self, evidence_entry: dict) -> str | None:
        url = (evidence_entry.get("url") or "").strip()
        title = (evidence_entry.get("title") or "").strip()
        return self._by_url.get(url) or self._by_title.get(title)

    def get_eval_set(self) -> list[EvalExample]:
        examples: list[EvalExample] = []
        for row in self._queries:
            gold: list[str] = []
            facts: list[str] = []
            for ev in row.get("evidence_list") or []:
                doc_id = self._resolve(ev)
                if doc_id is not None and doc_id not in gold:
                    gold.append(doc_id)
                fact = (ev.get("fact") or "").strip()
                if fact:
                    facts.append(fact)
            examples.append(
                EvalExample(
                    query=row["query"],
                    answer=row.get("answer", ""),
                    question_type=row.get("question_type", "inference_query"),
                    gold_doc_ids=tuple(gold),
                    evidence=tuple(facts),
                )
            )
        return examples
