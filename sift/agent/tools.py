"""The `search_knowledge_base` tool: schema + result formatting.

Retrieved chunks are returned to the model as Anthropic **search_result**
content blocks (GA, no beta header) with citations enabled. We set
``source`` = the stable ``chunk_id`` so every citation the model emits resolves
straight back to a real chunk in the corpus.
"""

from __future__ import annotations

from typing import Any

from core.models import RetrievedChunk

SEARCH_TOOL: dict[str, Any] = {
    "name": "search_knowledge_base",
    "description": (
        "Search the company knowledge base and return the most relevant passages "
        "as citable sources. Call this whenever you need facts to answer the "
        "question, including narrower follow-up searches for missing sub-facts."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "A focused natural-language search query.",
            }
        },
        "required": ["query"],
    },
}


def chunks_to_search_results(chunks: list[RetrievedChunk]) -> list[dict[str, Any]]:
    """Render retrieved chunks as `search_result` blocks with citations on.

    `source` carries the chunk_id (the citation key); `title` is human-facing.
    Each chunk is a single text block, so a citation covers the whole chunk.
    """
    blocks: list[dict[str, Any]] = []
    for rc in chunks:
        chunk = rc.chunk
        title = chunk.metadata.get("title") or chunk.doc_id
        blocks.append(
            {
                "type": "search_result",
                "source": chunk.chunk_id,
                "title": title,
                "content": [{"type": "text", "text": chunk.text}],
                "citations": {"enabled": True},
            }
        )
    if not blocks:
        # search_result.content must be non-empty and citations are all-or-nothing,
        # so signal "no hits" as a plain text tool result instead.
        return []
    return blocks
