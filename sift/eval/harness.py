"""Eval shell — run one example, print recall@5 and faithfulness.

This is the minimal shell that slices 2/4 grow into a full scorecard. It scores
two different failure modes (PLAN.md learning moment #7): retrieval recall is
measured against a direct top-k retrieval; faithfulness is measured against the
answer the agent actually produced.
"""

from __future__ import annotations

from dataclasses import dataclass

from core.models import EvalExample
from core.retriever import SupportsRetrieve
from agent.loop import run_agent
from eval.faithfulness import faithfulness
from eval.retrieval import recall_at_k


@dataclass
class EvalResult:
    example: EvalExample
    answer: str
    recall_at_5: float
    faithfulness: float
    faithfulness_reason: str
    n_citations: int


def evaluate_example(
    client,
    retriever: SupportsRetrieve,
    example: EvalExample,
    *,
    k: int = 5,
) -> EvalResult:
    # Retrieval metric: direct top-k retrieval against the gold doc ids.
    retrieved = retriever.retrieve(example.query, k=k)
    recall = recall_at_k(retrieved, example.gold_doc_ids, k)

    # Answer metric: run the agent, then judge its answer against what it saw.
    result = run_agent(client, retriever, example.query, k=k)
    faith, reason = faithfulness(
        client, example.query, result.answer, result.retrieved or retrieved
    )

    return EvalResult(
        example=example,
        answer=result.answer,
        recall_at_5=recall,
        faithfulness=faith,
        faithfulness_reason=reason,
        n_citations=len(result.citations),
    )


def print_eval(result: EvalResult) -> None:
    print("\n=== Eval shell (1 example) ===")
    print(f"question : {result.example.query}")
    print(f"gold docs: {', '.join(result.example.gold_doc_ids)}")
    print(f"recall@5     : {result.recall_at_5:.2f}")
    print(f"faithfulness : {result.faithfulness:.2f}  ({result.faithfulness_reason})")
