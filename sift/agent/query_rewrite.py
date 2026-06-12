"""Query rewriter — 3 paraphrases + 1 HyDE hypothetical, via Haiku.

Two complementary expansions of one search:

* **Paraphrases** vary surface form, so a chunk that uses different wording than
  the question still gets surfaced (helps both dense and BM25).
* **HyDE** (Hypothetical Document Embeddings) drafts a short *answer-shaped*
  passage; embedding that lands nearer the real evidence in vector space than the
  question does, because answers look like documents and questions don't.

Exactly four variants come back per call (3 paraphrases + 1 hypothetical), which
become the four parallel hybrid searches in :mod:`agent.multi_query`. Haiku is
used (not the Opus agent) — rewriting is cheap and doesn't need the big model.
"""

from __future__ import annotations

import json

REWRITE_MODEL = "claude-haiku-4-5"

_SCHEMA = {
    "type": "object",
    "properties": {
        "paraphrases": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Exactly three distinct rewordings of the question.",
        },
        "hypothetical": {
            "type": "string",
            "description": "A short hypothetical passage that would answer the question (HyDE).",
        },
    },
    "required": ["paraphrases", "hypothetical"],
    "additionalProperties": False,
}

_PROMPT = """\
Expand this search query to improve document retrieval.

Produce:
1. `paraphrases`: exactly 3 distinct rewordings that preserve the meaning but vary \
the surface form (synonyms, sentence shape, specificity).
2. `hypothetical`: a short, factual-sounding passage (2-3 sentences) that — if it \
existed in the corpus — would directly answer the question. Write it as a document \
excerpt, not as a question. Invent plausible specifics; this is only used as a \
retrieval probe.

QUERY:
{query}
"""


def rewrite_query(client, query: str) -> list[str]:
    """Return exactly 4 retrieval variants: [paraphrase × 3, hypothetical]."""
    response = client.messages.create(
        model=REWRITE_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": _PROMPT.format(query=query)}],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    data = json.loads(text)
    paraphrases = [p.strip() for p in data.get("paraphrases", []) if p.strip()][:3]
    hypothetical = (data.get("hypothetical") or "").strip()
    # Guard the "exactly 4" contract even if the model under-delivers.
    while len(paraphrases) < 3:
        paraphrases.append(query)
    variants = paraphrases[:3] + [hypothetical or query]
    return variants
