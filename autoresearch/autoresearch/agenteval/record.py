"""Build record-v2 attempts from retained runner artifacts."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
from typing import Any, Iterable

from autoresearch.score import Attempt
from autoresearch.trace import Call, Transcript

from .agent_side import detect_ignored_hints
from .contract import Record2
from .taxonomy import classify, classify_attempt


def build_record(attempt: Attempt, *, transcript_path: Path | None = None) -> Record2:
    """Convert an existing runner attempt into the shared record-v2 shape."""
    calls = tuple(_call_record(call) for call in attempt.calls)
    agent_side = tuple(detect_ignored_hints(calls))
    return Record2(
        schema="agenteval/2",
        question_id=attempt.question_id,
        repeat=attempt.repeat,
        calls=calls,
        agent_side=agent_side,
        tools_used=parse_tools_used(transcript_path) if transcript_path else {},
        botmap_calls=len(attempt.calls),
        answer={"text": attempt.transcript.final_answer, "verified": None},
        attempt=classify_attempt(attempt.transcript),
    )


def parse_tools_used(path: Path | None) -> dict[str, int]:
    """Count tool-use events in a Claude stream-json transcript."""
    if path is None or not path.exists():
        return {}
    counts: Counter[str] = Counter()
    for event in _events(path):
        message = event.get("message") or {}
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                name = part.get("name")
                if isinstance(name, str) and name:
                    counts[name] += 1
    return dict(counts)


def _events(path: Path) -> Iterable[dict[str, Any]]:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def _call_record(call: Call) -> dict[str, Any]:
    verdict = classify(call)
    return {
        "argv": call.argv,
        "exit_code": call.exit_code,
        "stdout_head": _head(call.stdout),
        "stderr_head": _head(call.stderr),
        "duration_s": call.duration,
        "outcome": verdict.outcome,
        "blame": verdict.blame,
        "recovery": verdict.recovery,
        "class": verdict.cls,
        "subtype": verdict.subtype,
        "evidence": verdict.evidence,
        "probes": [
            {"kind": probe.kind, "ran": probe.ran, "result": probe.result, "conclusive": probe.conclusive}
            for probe in verdict.probes
        ],
    }


def _head(text: str, limit: int = 2000) -> str:
    return text[:limit]
