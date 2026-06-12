"""Ragas v0.2 runner — the standard answer-quality suite.

Five metrics, two families:

* reference-free — ``faithfulness`` (answer entailed by retrieved context),
  ``answer_relevancy`` (answer addresses the question);
* reference-based — ``context_precision`` / ``context_recall`` (did retrieval put
  the right evidence in front of the model?) and ``factual_correctness`` (answer
  vs the gold answer).

The Ragas judge is **Claude Sonnet** (``claude-sonnet-4-6``) — distinct from the
Opus agent, so no metric grades its own model's output. Embeddings (needed by
``answer_relevancy``) are the local BGE model, so the suite has no third-party API
dependency. (We do not use OpenAI here: the only OpenAI key in this environment is
out of quota — and a local/Claude path keeps the eval reproducible at $0 + Claude.)

Returns one dict of scores per input sample (NaN → None so null/abstention rows
don't masquerade as zeros).
"""

from __future__ import annotations

import math

RAGAS_JUDGE_MODEL = "claude-sonnet-4-6"
RAGAS_EMBED_MODEL = "BAAI/bge-small-en-v1.5"

_METRIC_SPECS = ("context_precision", "context_recall", "faithfulness",
                 "answer_relevancy", "factual_correctness")


def _build_metrics():
    from ragas.metrics import (
        FactualCorrectness,
        Faithfulness,
        LLMContextPrecisionWithReference,
        LLMContextRecall,
        ResponseRelevancy,
    )

    return [
        ("context_precision", LLMContextPrecisionWithReference()),
        ("context_recall", LLMContextRecall()),
        ("faithfulness", Faithfulness()),
        ("answer_relevancy", ResponseRelevancy()),
        ("factual_correctness", FactualCorrectness()),
    ]


def _clean(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def score_samples(
    samples: list[dict],
    *,
    model: str = RAGAS_JUDGE_MODEL,
    embed_model: str = RAGAS_EMBED_MODEL,
) -> list[dict]:
    """Score samples ``[{question, contexts:[str], answer, reference}, ...]``.

    Returns one ``{friendly_key: float|None}`` per sample, in input order.
    """
    from langchain_anthropic import ChatAnthropic
    from langchain_community.embeddings import HuggingFaceEmbeddings
    from ragas import EvaluationDataset, SingleTurnSample, evaluate
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper

    if not samples:
        return []

    dataset = EvaluationDataset(
        samples=[
            SingleTurnSample(
                user_input=s["question"],
                retrieved_contexts=s.get("contexts") or [],
                response=s.get("answer") or "",
                reference=s.get("reference") or "",
            )
            for s in samples
        ]
    )

    llm = LangchainLLMWrapper(ChatAnthropic(model=model, temperature=0.0, max_tokens=4096))
    embeddings = LangchainEmbeddingsWrapper(
        HuggingFaceEmbeddings(model_name=embed_model)
    )
    named_metrics = _build_metrics()

    result = evaluate(
        dataset,
        metrics=[m for _, m in named_metrics],
        llm=llm,
        embeddings=embeddings,
        show_progress=True,
    )

    df = result.to_pandas()
    col_for = {key: metric.name for key, metric in named_metrics}
    out: list[dict] = []
    for i in range(len(samples)):
        row = df.iloc[i]
        out.append({key: _clean(row.get(col_for[key])) for key in _METRIC_SPECS})
    return out
