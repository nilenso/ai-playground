"""Faithfulness — is the answer supported by the retrieved context?

An LLM-as-judge metric. Per PLAN.md's learning moments, the judge runs on a
*different* model than the agent (Haiku, not Opus) to dampen self-preference
bias. The judge sees only the question, the answer, and the retrieved passages,
and returns the fraction of the answer's claims that are entailed by the context
(1.0 = fully grounded, 0.0 = unsupported). Slice 4 expands this into the full
Ragas + citation-judge scorecard.
"""

from __future__ import annotations

import json

from core.models import RetrievedChunk

JUDGE_MODEL = "claude-haiku-4-5"

_SCHEMA = {
    "type": "object",
    "properties": {
        "faithfulness": {
            "type": "number",
            "description": "Fraction of answer claims supported by the context, 0.0-1.0.",
        },
        "reason": {"type": "string"},
    },
    "required": ["faithfulness", "reason"],
    "additionalProperties": False,
}

_PROMPT = """\
You are grading whether an ANSWER is faithful to the retrieved CONTEXT.

Break the ANSWER into its distinct factual claims. A claim is "supported" only if \
it can be directly inferred from the CONTEXT. Report `faithfulness` as the fraction \
of claims that are supported (1.0 = every claim supported, 0.0 = none). Judge only \
grounding in the CONTEXT — not whether the answer is otherwise correct.

QUESTION:
{question}

CONTEXT:
{context}

ANSWER:
{answer}
"""


def faithfulness(
    client, question: str, answer: str, contexts: list[RetrievedChunk]
) -> tuple[float, str]:
    if not answer.strip():
        return 0.0, "empty answer"
    context_text = "\n\n".join(
        f"[{rc.chunk.chunk_id}] {rc.chunk.text}" for rc in contexts
    ) or "(no context retrieved)"

    response = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": _PROMPT.format(
                    question=question, context=context_text, answer=answer
                ),
            }
        ],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    data = json.loads(text)
    score = max(0.0, min(1.0, float(data.get("faithfulness", 0.0))))
    return score, data.get("reason", "")
