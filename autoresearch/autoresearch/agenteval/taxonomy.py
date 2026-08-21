"""Three-axis classifier for record-v2 call and attempt verdicts.

The taxonomy names what happened without deciding how much it costs.  The
A-F class is always derived through :func:`contract.derive_class`; clean calls
therefore carry ``cls=None`` and serialize as JSON ``"class": null``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .contract import AttemptVerdict, CallVerdict, Probe, derive_class


class CallLike(Protocol):
    argv: list[str]
    exit_code: int
    stdout: str
    stderr: str
    duration: float


_NETWORK_MARKERS = (
    "curlcode",
    "aws error network_connection",
    "timeout was reached",
    "connection reset by peer",
    "could not connect to",
    "failed to connect",
    "temporary failure in name resolution",
    "connection timed out",
)

_QUOTA_MARKERS = ("session limit", "usage limit", "rate limit")

_C_SUBTYPE_BY_PROBE = {
    "vocabulary": "c-vocabulary",
    "column_swap": "c-wrong-column",
    "column-swap": "c-wrong-column",
    "type_sweep": "c-wrong-type",
    "type-sweep": "c-wrong-type",
    "argv_echo": "c-dropped-input",
    "argv-echo": "c-dropped-input",
    "limit_raise": "c-truncated",
    "limit-raise": "c-truncated",
    "entity_check": "c-wrong-entity",
    "entity-check": "c-wrong-entity",
}


@dataclass(frozen=True)
class TranscriptLike:
    """Small adapter shape for attempt-level environment failures."""

    final_answer: str = ""
    quota_exhausted: bool = False


def classify(call: CallLike, probes: tuple[Probe, ...] | list[Probe] = ()) -> CallVerdict:
    """Classify one botmap call using the three axes.

    Probe evidence decides class-C subtypes.  Without conclusive probe evidence,
    an empty unguided call is still class C, subtype ``c-unknown``; it must never
    silently become clean.
    """
    probe_tuple = tuple(_coerce_probe(probe) for probe in probes)
    text = _text(call)

    if _is_network_failure(text):
        return _verdict(
            outcome="error",
            blame="environment",
            recovery="unguided",
            subtype=None,
            evidence="network/data access failure, not a tool defect",
            probes=probe_tuple,
        )

    if _has_guidance(text):
        return _verdict(
            outcome="error",
            blame="tool",
            recovery="guided",
            subtype=None,
            evidence="tool named a recovery path for the next iteration",
            probes=probe_tuple,
        )

    if _get(call, "exit_code", 0) != 0:
        return _verdict(
            outcome="error",
            blame="tool",
            recovery="unguided",
            subtype=None,
            evidence=_first_line(text) or "command failed without recovery guidance",
            probes=probe_tuple,
        )

    conclusive_subtype = _class_c_subtype(probe_tuple)
    if conclusive_subtype != "c-unknown":
        return _verdict(
            outcome="empty",
            blame="tool",
            recovery="unguided",
            subtype=conclusive_subtype,
            evidence=_empty_evidence(conclusive_subtype, probe_tuple),
            probes=probe_tuple,
        )

    if _is_degenerate(call):
        return _verdict(
            outcome="degenerate",
            blame="tool",
            recovery="n/a",
            subtype=None,
            evidence="command eventually answered but by an unusable route",
            probes=probe_tuple,
        )

    if _is_empty(call):
        return _verdict(
            outcome="empty",
            blame="tool",
            recovery="unguided",
            subtype="c-unknown",
            evidence="empty result with no conclusive probe; reason unknown",
            probes=probe_tuple,
        )

    return _verdict(
        outcome="ok",
        blame="tool",
        recovery="n/a",
        subtype=None,
        evidence="call completed with usable output",
        probes=probe_tuple,
    )


def classify_attempt(transcript: object) -> AttemptVerdict | None:
    """Classify attempt-level failures that may have no botmap call.

    Quota exhaustion belongs here: it is class E environment evidence, but there
    may be no ``Call`` to attach it to.
    """
    quota = bool(getattr(transcript, "quota_exhausted", False))
    answer = str(getattr(transcript, "final_answer", "") or "")
    if not quota and not any(marker in answer.lower() for marker in _QUOTA_MARKERS):
        return None
    outcome = "error"
    blame = "environment"
    recovery = "unguided"
    return AttemptVerdict(
        outcome=outcome,
        blame=blame,
        recovery=recovery,
        cls=derive_class(outcome, blame, recovery),
        subtype=None,
        evidence="model/session quota exhausted before the attempt could be measured",
    )


def _verdict(
    *,
    outcome: str,
    blame: str,
    recovery: str,
    subtype: str | None,
    evidence: str,
    probes: tuple[Probe, ...],
) -> CallVerdict:
    return CallVerdict(
        outcome=outcome,
        blame=blame,
        recovery=recovery,
        cls=derive_class(outcome, blame, recovery),
        subtype=subtype,
        evidence=evidence,
        probes=probes,
    )


def _text(call: CallLike) -> str:
    return f"{_get(call, 'stdout', _get(call, 'stdout_head', '')) or ''}\n{_get(call, 'stderr', _get(call, 'stderr_head', '')) or ''}"


def _get(call: object, name: str, default: object = None) -> object:
    if isinstance(call, dict):
        return call.get(name, default)
    return getattr(call, name, default)


def _coerce_probe(probe: Probe | dict) -> Probe:
    if isinstance(probe, Probe):
        return probe
    return Probe(
        kind=str(probe.get("kind", "")),
        ran=str(probe.get("ran", "")),
        result=str(probe.get("result", "")),
        conclusive=bool(probe.get("conclusive", False)),
    )


def _first_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def _is_network_failure(text: str) -> bool:
    low = text.lower()
    return any(marker in low for marker in _NETWORK_MARKERS)


def _has_guidance(text: str) -> bool:
    low = text.lower()
    return any(marker in low for marker in ("did you mean:", "try `", "try:", "use --"))


def _is_empty(call: CallLike) -> bool:
    stdout = str(_get(call, "stdout", _get(call, "stdout_head", "")) or "").strip().lower()
    stderr = str(_get(call, "stderr", _get(call, "stderr_head", "")) or "").strip().lower()
    if stderr:
        return False
    if stdout == "0":
        return True
    if '"count": 0' in stdout or "'count': 0" in stdout:
        return True
    return any(marker in stdout for marker in ("0 rows", "no rows", "no results"))


def _is_degenerate(call: CallLike) -> bool:
    duration = _get(call, "duration", _get(call, "duration_s", 0.0))
    try:
        return float(duration) >= 600.0
    except (TypeError, ValueError):
        return False


def _class_c_subtype(probes: tuple[Probe, ...]) -> str:
    for probe in probes:
        if probe.conclusive and probe.kind in _C_SUBTYPE_BY_PROBE:
            return _C_SUBTYPE_BY_PROBE[probe.kind]
    return "c-unknown"


def _empty_evidence(subtype: str, probes: tuple[Probe, ...]) -> str:
    conclusive = next((probe for probe in probes if probe.conclusive), None)
    if conclusive is None:
        return "empty result with no conclusive probe; reason unknown"
    return f"{subtype}: {conclusive.result}"
