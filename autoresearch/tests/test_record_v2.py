import json

from autoresearch.agenteval.contract import validate
from autoresearch.agenteval.record import build_record, parse_tools_used
from autoresearch.score import Attempt
from autoresearch.trace import Call, Transcript


def test_build_record_from_attempt_contains_verdicts_and_agent_side():
    attempt = Attempt(
        question_id="q",
        repeat=1,
        calls=[
            Call(["count"], 0, "", "Did you mean: bus_station"),
            Call(["categories", "-t", "place"], 0, "[]", ""),
        ],
        transcript=Transcript(final_answer="done", completed=True, status="ok"),
    )

    record = build_record(attempt)
    raw = {
        "schema": record.schema,
        "question_id": record.question_id,
        "repeat": record.repeat,
        "calls": list(record.calls),
        "agent_side": list(record.agent_side),
        "tools_used": record.tools_used,
        "botmap_calls": record.botmap_calls,
        "answer": record.answer,
        "attempt": None,
    }

    assert record.calls[0]["class"] == "B"
    assert record.agent_side[0]["kind"] == "ignored_hint"
    assert validate(raw) == []


def test_parse_tools_used_counts_claude_stream_events(tmp_path):
    path = tmp_path / "transcript.jsonl"
    path.write_text(
        json.dumps({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "Bash"},
                {"type": "tool_use", "name": "WebSearch"},
            ]},
        }) + "\n" + json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Bash"}]},
        }) + "\n",
        encoding="utf-8",
    )

    assert parse_tools_used(path) == {"Bash": 2, "WebSearch": 1}
