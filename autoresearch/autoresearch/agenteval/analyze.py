"""Offline analysis helpers for record-v2 measurement runs."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
from typing import Any


def summarize_run(run_dir: str | Path) -> dict[str, Any]:
    """Return class/subtype histograms for a run containing record-v2 files."""
    root = Path(run_dir)
    summary = _summarize_records(_records_by_attempt(root))
    summary["run_dir"] = str(root)
    return summary


def summarize_with_completed_retries(run_dir: str | Path, retry_dir: str | Path) -> dict[str, Any]:
    """Summarize a run, replacing attempts only when their retry completed.

    This keeps the original measurement auditable while answering the practical
    question: what class distribution do we get if transient timeouts are retried
    once and only successful retries are accepted?
    """
    base = _records_by_attempt(Path(run_dir))
    retry = _completed_retry_records(Path(retry_dir))
    combined = dict(base)
    combined.update(retry)
    summary = _summarize_records(combined)
    summary["run_dir"] = str(run_dir)
    summary["retry_dir"] = str(retry_dir)
    summary["retry_replacements"] = sorted(retry)
    return summary


def write_summary(run_dir: str | Path, out: str | Path | None = None) -> Path:
    """Summarize a run and write JSON beside it unless an output path is given."""
    root = Path(run_dir)
    target = Path(out) if out is not None else root / "agenteval-summary.json"
    target.write_text(json.dumps(summarize_run(root), indent=2), encoding="utf-8")
    return target


def write_combined_summary(run_dir: str | Path, retry_dir: str | Path, out: str | Path | None = None) -> Path:
    """Write a summary with completed retry attempts layered over the run."""
    root = Path(run_dir)
    target = Path(out) if out is not None else root / "agenteval-summary-with-retries.json"
    target.write_text(json.dumps(summarize_with_completed_retries(root, retry_dir), indent=2), encoding="utf-8")
    return target


def _summarize_records(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    class_counts: Counter[str] = Counter()
    subtype_counts: Counter[str] = Counter()
    agent_side_counts: Counter[str] = Counter()
    attempts_with_failures = 0
    details: list[dict[str, Any]] = []

    for attempt_name, raw in sorted(records.items()):
        failures: list[dict[str, Any]] = []
        attempt = raw.get("attempt")
        if attempt and attempt.get("class") is not None:
            class_counts[attempt["class"]] += 1
            failures.append({"scope": "attempt", "class": attempt.get("class"), "evidence": attempt.get("evidence")})
        for index, call in enumerate(raw.get("calls", [])):
            cls = call.get("class")
            if cls is None:
                class_counts["clean"] += 1
                continue
            class_counts[cls] += 1
            subtype = call.get("subtype")
            if subtype:
                subtype_counts[subtype] += 1
            failures.append(
                {
                    "scope": "call",
                    "index": index,
                    "class": cls,
                    "subtype": subtype,
                    "argv": call.get("argv", []),
                    "evidence": call.get("evidence"),
                }
            )
        for item in raw.get("agent_side", []):
            kind = item.get("kind", "unknown")
            agent_side_counts[kind] += 1
            failures.append({"scope": "agent_side", "kind": kind, "detail": item.get("detail")})
        if failures:
            attempts_with_failures += 1
        details.append(
            {
                "attempt": attempt_name,
                "question_id": raw.get("question_id"),
                "repeat": raw.get("repeat"),
                "botmap_calls": raw.get("botmap_calls"),
                "failures": failures,
            }
        )

    return {
        "records": len(records),
        "attempts_with_failures": attempts_with_failures,
        "class_counts": dict(class_counts),
        "subtype_counts": dict(subtype_counts),
        "agent_side_counts": dict(agent_side_counts),
        "details": details,
    }


def _records_by_attempt(run_dir: Path) -> dict[str, dict[str, Any]]:
    records = {}
    for path in sorted(run_dir.glob("attempts/*/record-v2.json")):
        records[path.parent.name] = json.loads(path.read_text(encoding="utf-8"))
    return records


def _completed_retry_records(retry_dir: Path) -> dict[str, dict[str, Any]]:
    completed = set()
    progress = retry_dir / "progress.jsonl"
    if progress.exists():
        for line in progress.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("completed"):
                completed.add(event.get("attempt"))
    return {name: raw for name, raw in _records_by_attempt(retry_dir).items() if name in completed}
