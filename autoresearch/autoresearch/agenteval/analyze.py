"""Offline analysis helpers for record-v2 measurement runs."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
from typing import Any


def summarize_run(run_dir: str | Path) -> dict[str, Any]:
    """Return class/subtype histograms for a run containing record-v2 files."""
    root = Path(run_dir)
    records = sorted(root.glob("attempts/*/record-v2.json"))
    class_counts: Counter[str] = Counter()
    subtype_counts: Counter[str] = Counter()
    agent_side_counts: Counter[str] = Counter()
    attempts_with_failures = 0
    details: list[dict[str, Any]] = []

    for path in records:
        raw = json.loads(path.read_text(encoding="utf-8"))
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
                "attempt": path.parent.name,
                "question_id": raw.get("question_id"),
                "repeat": raw.get("repeat"),
                "botmap_calls": raw.get("botmap_calls"),
                "failures": failures,
            }
        )

    return {
        "run_dir": str(root),
        "records": len(records),
        "attempts_with_failures": attempts_with_failures,
        "class_counts": dict(class_counts),
        "subtype_counts": dict(subtype_counts),
        "agent_side_counts": dict(agent_side_counts),
        "details": details,
    }


def write_summary(run_dir: str | Path, out: str | Path | None = None) -> Path:
    """Summarize a run and write JSON beside it unless an output path is given."""
    root = Path(run_dir)
    target = Path(out) if out is not None else root / "agenteval-summary.json"
    target.write_text(json.dumps(summarize_run(root), indent=2), encoding="utf-8")
    return target
