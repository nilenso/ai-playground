"""Offline tests for the agent loop — no network, no API key.

Covers the turn-cap acceptance criterion: a model that never stops asking for
tools must be halted at `max_turns`, not loop forever.
"""

from __future__ import annotations

from types import SimpleNamespace

from agent.loop import run_agent
from core.models import Chunk, RetrievedChunk


class _AlwaysToolUseClient:
    """Fake Anthropic client whose model forever requests another search."""

    def __init__(self) -> None:
        self.calls = 0
        self.messages = self

    def create(self, **_kwargs):
        self.calls += 1
        tool_use = SimpleNamespace(
            type="tool_use", name="search_knowledge_base", id=f"t{self.calls}",
            input={"query": "again"},
        )
        return SimpleNamespace(stop_reason="tool_use", content=[tool_use])


class _StubRetriever:
    def retrieve(self, query: str, k: int):
        chunk = Chunk(chunk_id="doc_x::0", doc_id="doc_x", text="t", ordinal=0, metadata={})
        return [RetrievedChunk(chunk=chunk, score=1.0, rank=0, retriever="dense")]


def test_turn_cap_halts_runaway():
    client = _AlwaysToolUseClient()
    result = run_agent(client, _StubRetriever(), "q", max_turns=3)
    assert result.stopped_on_cap is True
    assert result.turns == 3
    assert client.calls == 3  # never exceeds the cap
    assert len(result.searches) == 3


class _AnswerThenStopClient:
    def __init__(self) -> None:
        self.calls = 0
        self.messages = self

    def create(self, **_kwargs):
        self.calls += 1
        if self.calls == 1:
            tool_use = SimpleNamespace(
                type="tool_use", name="search_knowledge_base", id="t1",
                input={"query": "activision"},
            )
            return SimpleNamespace(stop_reason="tool_use", content=[tool_use])
        cited = SimpleNamespace(
            type="text",
            text="Microsoft.",
            citations=[
                SimpleNamespace(
                    type="search_result_location", source="doc_01::0",
                    title="t", cited_text="Microsoft acquired Activision Blizzard.",
                    search_result_index=0, start_block_index=0, end_block_index=1,
                )
            ],
        )
        return SimpleNamespace(stop_reason="end_turn", content=[cited])


def test_normal_run_extracts_answer_and_citations():
    client = _AnswerThenStopClient()
    result = run_agent(client, _StubRetriever(), "who acquired activision?")
    assert result.stopped_on_cap is False
    assert result.turns == 2
    assert result.answer == "Microsoft."
    assert len(result.citations) == 1
    assert result.citations[0].chunk_id == "doc_01::0"
    assert result.citations[0].doc_id == "doc_01"
