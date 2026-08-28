"""Human-readable feedback for agent-evaluation records."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from autoresearch.agenteval.contract import Record2

CLASS_NAMES = {
    "A": "hard failure",
    "B": "soft failure",
    "C": "silent wrong",
    "D": "degenerate",
    "E": "environment",
    "F": "agent-side",
    None: "clean",
}


def explain(record: Record2 | dict[str, Any]) -> str:
    """Turn a record-v2 attempt into fix-instruction feedback."""
    raw = _raw(record)
    lines = [f"QUESTION {raw.get('question_id', '<unknown>')} repeat {raw.get('repeat', '<unknown>')}"]

    attempt = raw.get("attempt")
    if attempt:
        lines.extend(_explain_verdict("ATTEMPT", attempt))

    for index, call in enumerate(raw.get("calls", [])):
        cls = _class(call)
        if cls is None:
            continue
        lines.extend(_explain_verdict(f"CALL {index}", call))

    for item in raw.get("agent_side", []):
        lines.extend(_explain_agent_side(item))

    if len(lines) == 1:
        lines.append("No classified failures.")
    return "\n".join(lines)


def _explain_verdict(label: str, verdict: dict[str, Any]) -> list[str]:
    cls = _class(verdict)
    subtype = verdict.get("subtype")
    heading = f"{label}: CLASS {cls} ({CLASS_NAMES.get(cls, 'unknown')})"
    if subtype:
        heading += f" - {subtype}"

    lines = [heading]
    argv = verdict.get("argv")
    if argv is not None:
        lines.append(f"  The agent ran: {_format_argv(argv)}")
    if "exit_code" in verdict:
        lines.append(f"  Result: exit {verdict.get('exit_code')}, stdout={_head(verdict, 'stdout')!r}, stderr={_head(verdict, 'stderr')!r}")
    if verdict.get("evidence"):
        lines.append(f"  Evidence: {verdict['evidence']}")
    for probe in verdict.get("probes", []):
        lines.append(_explain_probe(probe))
    lines.append(f"  Missing behaviour: {_missing_behaviour(cls, subtype, verdict)}")
    return lines


def _explain_probe(probe: dict[str, Any]) -> str:
    status = "conclusive" if probe.get("conclusive") else "inconclusive"
    return f"  Probe ({probe.get('kind')}, {status}): `{probe.get('ran', '')}` -> {probe.get('result', '')}"


def _explain_agent_side(item: dict[str, Any]) -> list[str]:
    lines = [f"AGENT-SIDE: {item.get('kind', 'unknown')}"]
    if item.get("detail"):
        lines.append(f"  Detail: {item['detail']}")
    if item.get("ignored_by_next") is not None:
        lines.append(f"  Strict ignored-by-next: {item['ignored_by_next']}")
    if item.get("suggestions"):
        lines.append(f"  Suggestions: {', '.join(item['suggestions'])}")
    if item.get("eventually_used") is not None:
        lines.append(f"  Eventually used: {item['eventually_used']} at call {item.get('used_at_call')}")
    return lines


def _missing_behaviour(cls: str | None, subtype: str | None, verdict: dict[str, Any]) -> str:
    if cls == "A":
        return "refuse with a usable next action instead of leaving the agent stuck"
    if cls == "B":
        return "guided recovery was present; check whether the next agent step used it"
    if cls == "C":
        return _class_c_behaviour(subtype)
    if cls == "D":
        return "emit progress or provide a cheaper first-class route for the task"
    if cls == "E":
        return "exclude this attempt from tool scoring; environment failed outside the CLI contract"
    if cls == "F":
        return "record agent non-use separately; do not charge the tool for a usable hint being ignored"
    return "none"


def _class_c_behaviour(subtype: str | None) -> str:
    return {
        "c-vocabulary": "never return empty without saying the value is absent from the taxonomy and naming nearest real values",
        "c-wrong-column": "if a value exists in another field, say which field and give the corrected filter",
        "c-wrong-type": "if the data lives under another type or verb, name that route",
        "c-dropped-input": "reject or echo repeated/conflicting inputs instead of silently discarding one",
        "c-truncated": "say when output hit a limit and how to raise it",
        "c-wrong-entity": "confirm the resolved entity, including country/region, when the qualifier is ambiguous",
        "c-unknown": "say that zero is unexplained and surface safe discovery probes",
        None: "never return an unexplained empty result",
    }.get(subtype, "never return an unexplained empty result")


def _format_argv(argv: Any) -> str:
    return " ".join(str(part) for part in argv)


def _head(verdict: dict[str, Any], stream: str) -> str:
    return str(verdict.get(f"{stream}_head", verdict.get(stream, "")))[:200]


def _class(verdict: dict[str, Any]) -> str | None:
    return verdict.get("class", verdict.get("cls"))


def _raw(record: Record2 | dict[str, Any]) -> dict[str, Any]:
    if isinstance(record, dict):
        return record
    if is_dataclass(record):
        raw = asdict(record)
        for call in raw.get("calls", []):
            if "cls" in call:
                call["class"] = call.pop("cls")
        if raw.get("attempt") and "cls" in raw["attempt"]:
            raw["attempt"]["class"] = raw["attempt"].pop("cls")
        return raw
    raise TypeError(f"unsupported record type: {type(record)!r}")
