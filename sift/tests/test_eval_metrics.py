"""Offline tests for the slice 2-5 eval plumbing — metrics, stratification, RRF.

All deterministic, no network / API key. Locks the behaviour the slice scorecards
depend on: doc-level recall/MRR/NDCG, null-query handling, balanced sampling, and
the client-side RRF merge that multi-query fusion rides on.
"""

from __future__ import annotations

from collections import Counter

import pytest

from core.models import Chunk, EvalExample, RetrievedChunk
from eval.retrieval import mrr, ndcg_at_k, per_query_metrics, recall_at_k
from eval.stratified import QUERY_TYPES, build_stratified_eval


def _rc(doc_id: str, ordinal: int = 0, rank: int = 0) -> RetrievedChunk:
    chunk = Chunk(
        chunk_id=Chunk.make_id(doc_id, ordinal),
        doc_id=doc_id,
        text="t",
        ordinal=ordinal,
        metadata={},
    )
    return RetrievedChunk(chunk=chunk, score=1.0 / (rank + 1), rank=rank, retriever="dense")


def _ranking(doc_ids: list[str]) -> list[RetrievedChunk]:
    return [_rc(d, ordinal=i, rank=i) for i, d in enumerate(doc_ids)]


def test_recall_dedups_by_doc_and_respects_k():
    # two gold docs (A, B); A appears twice, B is at rank 4 (outside top-3)
    ranking = _ranking(["A", "A", "C", "B"])
    assert recall_at_k(ranking, ["A", "B"], k=3) == 0.5  # only A in top-3
    assert recall_at_k(ranking, ["A", "B"], k=4) == 1.0


def test_mrr_is_first_gold_rank():
    ranking = _ranking(["X", "A", "B"])  # first gold (A) at rank 2
    assert mrr(ranking, ["A", "B"]) == pytest.approx(0.5)
    assert mrr(ranking, ["Z"]) == 0.0


def test_ndcg_perfect_and_imperfect():
    # gold {A,B}; perfect ranking puts both first
    assert ndcg_at_k(_ranking(["A", "B", "C"]), ["A", "B"], k=10) == pytest.approx(1.0)
    # one gold at rank 1, the other missing → < 1
    assert 0.0 < ndcg_at_k(_ranking(["A", "C", "D"]), ["A", "B"], k=10) < 1.0


def test_per_query_metrics_none_for_empty_gold():
    assert per_query_metrics(_ranking(["A"]), [], ks=(5,)) is None
    assert per_query_metrics(_ranking(["A"]), ["A"], ks=(5,)) is not None


def _examples() -> list[EvalExample]:
    out = []
    counts = {"inference_query": 40, "comparison_query": 40,
              "temporal_query": 40, "null_query": 40, "other": 5}
    for qtype, n in counts.items():
        for i in range(n):
            out.append(EvalExample(query=f"{qtype}-{i}", answer="a", question_type=qtype))
    return out


def test_stratified_is_balanced_and_deterministic():
    a = build_stratified_eval(_examples(), per_type=25)
    b = build_stratified_eval(_examples(), per_type=25)
    assert len(a) == 100
    assert Counter(e.question_type for e in a) == {t: 25 for t in QUERY_TYPES}
    assert [e.query for e in a] == [e.query for e in b]  # seeded → reproducible


def test_stratified_raises_when_too_few():
    few = [EvalExample(query=f"q{i}", answer="a", question_type="null_query") for i in range(5)]
    with pytest.raises(ValueError):
        build_stratified_eval(few, per_type=25)


def test_rrf_merge_rewards_agreement():
    from agent.multi_query import MultiQueryRetriever

    # doc B is mid-rank in both lists; A tops list1, C tops list2.
    list1 = _ranking(["A", "B", "X"])
    list2 = _ranking(["C", "B", "Y"])
    merged = MultiQueryRetriever._rrf_merge([list1, list2])
    ids = [rc.chunk.doc_id for rc in merged]
    assert ids[0] == "B"  # agreed-on doc wins over either list's top
    assert merged[0].retriever == "rrf"
