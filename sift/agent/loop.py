"""The agent loop: search → cite → answer, with a hard turn cap.

The loop is the canonical `while tool_use: execute; append; resend`. It imports
only `core` Protocols plus the Anthropic SDK — never an adapter. Retrieval is
injected as anything that satisfies `SupportsRetrieve`, so swapping dense-only
for hybrid+rerank later touches nothing here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.models import Citation, RetrievedChunk
from core.retriever import SupportsRetrieve
from agent.prompts import SYSTEM_PROMPT
from agent.tools import SEARCH_TOOL, chunks_to_search_results

DEFAULT_MODEL = "claude-opus-4-8"


@dataclass
class AgentResult:
    answer: str
    citations: list[Citation]
    retrieved: list[RetrievedChunk]
    turns: int
    stopped_on_cap: bool
    searches: list[str] = field(default_factory=list)


def run_agent(
    client,
    retriever: SupportsRetrieve,
    question: str,
    *,
    model: str = DEFAULT_MODEL,
    k: int = 5,
    max_turns: int = 6,
    max_tokens: int = 4096,
) -> AgentResult:
    messages: list[dict] = [{"role": "user", "content": question}]
    retrieved: list[RetrievedChunk] = []
    seen_chunk_ids: set[str] = set()
    searches: list[str] = []

    turns = 0
    stopped_on_cap = False
    response = None
    while True:
        if turns >= max_turns:
            # Turn cap: stop before another model call to prevent runaway tool-use.
            stopped_on_cap = True
            break
        turns += 1

        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            tools=[SEARCH_TOOL],
            messages=messages,
        )

        # Preserve full content (thinking + tool_use blocks) for the next turn.
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            break

        tool_results = []
        for block in response.content:
            if block.type != "tool_use" or block.name != "search_knowledge_base":
                continue
            query = (block.input or {}).get("query", "")
            searches.append(query)
            hits = retriever.retrieve(query, k=k)
            for rc in hits:
                if rc.chunk.chunk_id not in seen_chunk_ids:
                    seen_chunk_ids.add(rc.chunk.chunk_id)
                    retrieved.append(rc)
            search_results = chunks_to_search_results(hits)
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": search_results
                    if search_results
                    else "No relevant results found in the knowledge base.",
                }
            )
        messages.append({"role": "user", "content": tool_results})

    answer, citations = _extract_answer(response)
    return AgentResult(
        answer=answer,
        citations=citations,
        retrieved=retrieved,
        turns=turns,
        stopped_on_cap=stopped_on_cap,
        searches=searches,
    )


def _extract_answer(response) -> tuple[str, list[Citation]]:
    """Pull final text + structured search-result citations from a message."""
    if response is None:
        return "", []
    text_parts: list[str] = []
    citations: list[Citation] = []
    for block in response.content:
        if block.type != "text":
            continue
        text_parts.append(block.text)
        for cit in getattr(block, "citations", None) or []:
            if getattr(cit, "type", None) != "search_result_location":
                continue
            chunk_id = getattr(cit, "source", None)
            doc_id = chunk_id.split("::", 1)[0] if chunk_id and "::" in chunk_id else chunk_id
            citations.append(
                Citation(
                    cited_text=getattr(cit, "cited_text", ""),
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    title=getattr(cit, "title", None),
                    search_result_index=getattr(cit, "search_result_index", None),
                    start_block_index=getattr(cit, "start_block_index", None),
                    end_block_index=getattr(cit, "end_block_index", None),
                )
            )
    return "".join(text_parts).strip(), citations
