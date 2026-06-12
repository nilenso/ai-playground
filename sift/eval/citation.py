"""Custom citation judge — the two metrics this project specifically cares about.

Ragas covers generic answer quality; these two are about *trust*: can a reader
click a claim and land on text that actually backs it?

* **citation_precision** — of the citations the answer emits, what fraction point
  to a passage that genuinely supports the attached claim? (Catches "cited the
  wrong source" / decorative citations.)
* **citation_coverage** — of the answer's *load-bearing* factual claims, what
  fraction carry at least one citation? (Catches confident, uncited assertions.)

One structured judge call per answer. The judge is a **different** Claude model
than the agent (agent = Opus ``claude-opus-4-8``; judge = Sonnet
``claude-sonnet-4-6``) to dampen self-preference bias (PLAN.md learning #8).

Null / "I don't know" answers have no load-bearing claims and no citations, so
both metrics are reported as ``None`` (undefined) rather than a misleading 1.0
or 0.0 — abstention quality is scored by faithfulness / the IDK rate instead.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from core.models import Citation

JUDGE_MODEL = "claude-sonnet-4-6"

_SCHEMA = {
    "type": "object",
    "properties": {
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string"},
                    "load_bearing": {
                        "type": "boolean",
                        "description": "True if this is a substantive factual claim that should be cited.",
                    },
                    "has_citation": {
                        "type": "boolean",
                        "description": "True if a citation is attached to / clearly supports this claim.",
                    },
                },
                "required": ["claim", "load_bearing", "has_citation"],
                "additionalProperties": False,
            },
        },
        "citation_support": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "supports": {
                        "type": "boolean",
                        "description": "Does the cited passage actually support the claim it is attached to?",
                    },
                },
                "required": ["index", "supports"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["claims", "citation_support"],
    "additionalProperties": False,
}

_PROMPT = """\
You are auditing the citations in an ANSWER produced by a research agent.

Do two things:

1. Decompose the ANSWER into its distinct factual claims. For each, set \
`load_bearing` true if it is a substantive factual assertion that a reader would \
want a source for (skip hedging, framing, and restatements of the question). Set \
`has_citation` true if one of the CITED PASSAGES below is attached to or clearly \
supports that claim.

2. For each CITED PASSAGE (by its index), set `supports` true only if that passage \
genuinely backs the claim it is attached to in the answer — not merely on-topic.

QUESTION:
{question}

ANSWER:
{answer}

CITED PASSAGES:
{citations}
"""


@dataclass
class CitationScore:
    citation_precision: float | None
    citation_coverage: float | None
    n_citations: int
    n_load_bearing: int


def _render_citations(citations: list[Citation]) -> str:
    if not citations:
        return "(the answer contains no citations)"
    lines = []
    for i, c in enumerate(citations):
        text = (c.cited_text or "").strip().replace("\n", " ")
        lines.append(f"[{i}] (source {c.chunk_id}) {text}")
    return "\n".join(lines)


def judge_citations(
    client, question: str, answer: str, citations: list[Citation]
) -> CitationScore:
    if not answer.strip():
        return CitationScore(None, None, 0, 0)

    response = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": _PROMPT.format(
                    question=question,
                    answer=answer,
                    citations=_render_citations(citations),
                ),
            }
        ],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    data = json.loads(text)

    claims = data.get("claims", [])
    load_bearing = [c for c in claims if c.get("load_bearing")]
    coverage = (
        sum(1 for c in load_bearing if c.get("has_citation")) / len(load_bearing)
        if load_bearing
        else None
    )

    support = data.get("citation_support", [])
    precision = (
        sum(1 for s in support if s.get("supports")) / len(support)
        if support
        else None
    )

    return CitationScore(
        citation_precision=precision,
        citation_coverage=coverage,
        n_citations=len(citations),
        n_load_bearing=len(load_bearing),
    )
