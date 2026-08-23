"""Repair helpers for already-written record-v2 artifacts.

These functions are for instrument bugs, not result editing.  They preserve the
original attempts and only recompute fields derived from evaluator logic.
"""

from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path
import re
from typing import Any

from autoresearch.trace import Call

from .contract import write as write_record
from .record import build_record
from .taxonomy import classify

_FALSE_US_ENTITY = re.compile(
    r"qualifier (?P<q>[A-Z]{2}) implies country (?P=q), but resolved .* country US / region US-(?P=q)"
)


def repair_us_state_entity_false_positives(run_dir: str | Path) -> dict[str, int]:
    """Remove stale c-wrong-entity probes caused by MA/MT country-code ambiguity.

    Older probe logic checked ISO country codes before US state codes.  That made
    `Cambridge, MA -> US-MA` look wrong because `MA` is also Morocco.  This
    function strips only those stale probes and reclassifies the affected calls.
    """
    root = Path(run_dir)
    stats = {"records_seen": 0, "calls_repaired": 0, "probes_removed": 0}
    for record_path in sorted(root.glob("attempts/*/record-v2.json")):
        raw = json.loads(record_path.read_text(encoding="utf-8"))
        stats["records_seen"] += 1
        changed = False
        repaired_calls = []
        for call in raw.get("calls", []):
            probes = call.get("probes") or []
            kept = []
            removed = 0
            for probe in probes:
                if probe.get("kind") == "entity_check" and _FALSE_US_ENTITY.search(str(probe.get("result", ""))):
                    removed += 1
                    continue
                kept.append(probe)
            if removed:
                stats["probes_removed"] += removed
                stats["calls_repaired"] += 1
                verdict = classify(_call_from_record(call), kept)
                call = dict(call)
                call.update(
                    outcome=verdict.outcome,
                    blame=verdict.blame,
                    recovery=verdict.recovery,
                    **{"class": verdict.cls},
                    subtype=verdict.subtype,
                    evidence=verdict.evidence,
                    probes=[asdict(probe) for probe in verdict.probes],
                )
                changed = True
            repaired_calls.append(call)
        if changed:
            raw["calls"] = repaired_calls
            # Preserve all raw metadata while using the contract writer for a
            # stable class/null JSON representation.
            record = build_record(_attempt_from_raw(raw), transcript_path=None)
            record = type(record)(
                schema=raw["schema"],
                question_id=raw["question_id"],
                repeat=raw["repeat"],
                calls=tuple(raw["calls"]),
                agent_side=tuple(raw.get("agent_side", [])),
                tools_used=dict(raw.get("tools_used", {})),
                botmap_calls=int(raw.get("botmap_calls", 0)),
                answer=dict(raw.get("answer", {})),
                attempt=record.attempt,
            )
            write_record(record_path, record)
    return stats


def _call_from_record(call: dict[str, Any]) -> Call:
    return Call(
        argv=list(call.get("argv") or []),
        exit_code=int(call.get("exit_code") or 0),
        stdout=str(call.get("stdout", call.get("stdout_head", "")) or ""),
        stderr=str(call.get("stderr", call.get("stderr_head", "")) or ""),
        duration=float(call.get("duration_s") or call.get("duration") or 0.0),
    )


def _attempt_from_raw(raw: dict[str, Any]):
    from autoresearch.score import Attempt
    from autoresearch.trace import Transcript

    calls = [_call_from_record(call) for call in raw.get("calls", [])]
    return Attempt(
        question_id=str(raw.get("question_id", "")),
        repeat=int(raw.get("repeat") or 0),
        calls=calls,
        transcript=Transcript(final_answer=str((raw.get("answer") or {}).get("text", "")), completed=True, status="ok"),
    )
