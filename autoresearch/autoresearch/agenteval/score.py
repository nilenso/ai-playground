"""Class-weighted scoring for the shared agent evaluator.

The top-level shape is fixed from the Phase 5 scoring decision:

- correctness and recoverability: 60%
- token efficiency: 20%
- wall-clock time: 20%

The 60 correctness/recoverability points are split as:

- final outcome correctness: 20
- self-recovery: 20
- guidance / error quality: 12
- execution / route quality: 6
- failure severity / attribution: 2

Class E is excluded. Class F is recorded but not charged to the CLI.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .contract import AttemptVerdict, CallVerdict, Probe

CORRECTNESS_RECOVERABILITY_WEIGHT = 0.60
TOKEN_EFFICIENCY_WEIGHT = 0.20
WALLCLOCK_WEIGHT = 0.20

FINAL_OUTCOME_POINTS = 20.0
SELF_RECOVERY_POINTS = 20.0
GUIDANCE_POINTS = 12.0
ROUTE_POINTS = 6.0
ATTRIBUTION_POINTS = 2.0
TOTAL_CORRECTNESS_POINTS = (
    FINAL_OUTCOME_POINTS
    + SELF_RECOVERY_POINTS
    + GUIDANCE_POINTS
    + ROUTE_POINTS
    + ATTRIBUTION_POINTS
)

# TODO(phase-5+): calibrate exact penalties against measured distribution.
CLASS_SEVERITY_PENALTIES = {
    "A": 1.00,
    "B": 0.10,
    "C": 1.00,
    "D": 0.45,
}


@dataclass(frozen=True)
class RecoveryStats:
    recoverable_failures: int
    recovered_failures: int
    self_recovery_rate: float | None
    extra_calls: int
    extra_tokens: int
    extra_wallclock_ms: int


@dataclass(frozen=True)
class ScoreBreakdown:
    final_outcome: float
    self_recovery: float
    guidance: float
    route_quality: float
    attribution: float
    correctness_recoverability: float
    token_efficiency: float
    wallclock: float


@dataclass(frozen=True)
class Score:
    value: float | None
    excluded: bool
    charged: tuple[CallVerdict, ...]
    recorded_not_charged: tuple[CallVerdict, ...]
    environment: tuple[CallVerdict, ...]
    breakdown: ScoreBreakdown
    recovery: RecoveryStats
    attempt_environment: AttemptVerdict | None = None


def score_attempt(
    calls: Iterable[CallVerdict],
    *,
    attempt: AttemptVerdict | None = None,
    agent_side: Iterable[dict] = (),
    completed: bool = True,
    token_efficiency: float = 1.0,
    wallclock: float = 1.0,
    extra_tokens: int = 0,
    extra_wallclock_ms: int = 0,
) -> Score:
    """Score one attempt.

    ``token_efficiency`` and ``wallclock`` are normalized 0..1 values supplied by
    the outer evaluator when a reference baseline exists.  This module owns the
    class semantics and recovery accounting.
    """
    call_tuple = tuple(calls)
    agent_side_tuple = tuple(agent_side)
    environment = tuple(call for call in call_tuple if call.cls == "E")
    recorded_not_charged = tuple(call for call in call_tuple if call.cls == "F")
    charged = tuple(call for call in call_tuple if call.cls not in {"E", "F"})
    recovery = _recovery_stats(charged, agent_side_tuple, extra_tokens, extra_wallclock_ms)
    empty_breakdown = ScoreBreakdown(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    if attempt is not None and attempt.cls == "E" and not charged:
        return Score(
            value=None,
            excluded=True,
            charged=(),
            recorded_not_charged=recorded_not_charged,
            environment=environment,
            breakdown=empty_breakdown,
            recovery=recovery,
            attempt_environment=attempt,
        )

    if not completed:
        return Score(
            value=0.0,
            excluded=False,
            charged=charged,
            recorded_not_charged=recorded_not_charged,
            environment=environment,
            breakdown=empty_breakdown,
            recovery=recovery,
            attempt_environment=attempt if attempt and attempt.cls == "E" else None,
        )

    breakdown = _breakdown(
        charged,
        completed=completed,
        recovery=recovery,
        token_efficiency=token_efficiency,
        wallclock=wallclock,
    )
    value = (
        CORRECTNESS_RECOVERABILITY_WEIGHT * breakdown.correctness_recoverability
        + TOKEN_EFFICIENCY_WEIGHT * breakdown.token_efficiency
        + WALLCLOCK_WEIGHT * breakdown.wallclock
    )
    return Score(
        value=max(0.0, min(1.0, value)),
        excluded=False,
        charged=charged,
        recorded_not_charged=recorded_not_charged,
        environment=environment,
        breakdown=breakdown,
        recovery=recovery,
        attempt_environment=attempt if attempt and attempt.cls == "E" else None,
    )


def score_record(
    record: object,
    *,
    completed: bool = True,
    token_efficiency: float = 1.0,
    wallclock: float = 1.0,
    extra_tokens: int = 0,
    extra_wallclock_ms: int = 0,
) -> Score:
    """Score a record-v2 object or raw dictionary.

    This is the integration point for the runner/evaluator: record-v2 remains
    the auditable source, and scoring reads the same verdict fields that are
    written to disk.
    """
    raw = _raw_record(record)
    return score_attempt(
        [_call_verdict(call) for call in raw.get("calls", ())],
        attempt=_attempt_verdict(raw.get("attempt")),
        agent_side=raw.get("agent_side", ()),
        completed=completed,
        token_efficiency=token_efficiency,
        wallclock=wallclock,
        extra_tokens=extra_tokens,
        extra_wallclock_ms=extra_wallclock_ms,
    )


def efficiency(reference: float | None, actual: float) -> float:
    """Normalize cost/time against the unchanged tool.

    0.5 means parity, below is worse, above is better.  No reference is neutral
    rather than free full credit.
    """
    if not reference or actual <= 0:
        return 0.5
    return min(2.0, reference / actual) / 2.0


def _breakdown(
    charged: tuple[CallVerdict, ...],
    *,
    completed: bool,
    recovery: RecoveryStats,
    token_efficiency: float,
    wallclock: float,
) -> ScoreBreakdown:
    final_outcome = _final_outcome_quality(charged, completed)
    self_recovery = recovery.self_recovery_rate if recovery.self_recovery_rate is not None else 1.0
    guidance = _guidance_quality(charged)
    route_quality = _route_quality(charged)
    attribution = _attribution_quality(charged)
    correctness = (
        FINAL_OUTCOME_POINTS * final_outcome
        + SELF_RECOVERY_POINTS * self_recovery
        + GUIDANCE_POINTS * guidance
        + ROUTE_POINTS * route_quality
        + ATTRIBUTION_POINTS * attribution
    ) / TOTAL_CORRECTNESS_POINTS
    return ScoreBreakdown(
        final_outcome=final_outcome,
        self_recovery=self_recovery,
        guidance=guidance,
        route_quality=route_quality,
        attribution=attribution,
        correctness_recoverability=max(0.0, min(1.0, correctness)),
        token_efficiency=max(0.0, min(1.0, token_efficiency)),
        wallclock=max(0.0, min(1.0, wallclock)),
    )


def _final_outcome_quality(calls: tuple[CallVerdict, ...], completed: bool) -> float:
    if not completed:
        return 0.0
    if any(call.cls == "C" for call in calls):
        return 0.0
    if any(call.cls == "A" for call in calls):
        return 0.35
    if any(call.cls == "D" for call in calls):
        return 0.75
    return 1.0


def _recovery_stats(
    calls: tuple[CallVerdict, ...],
    agent_side: tuple[dict, ...],
    extra_tokens: int,
    extra_wallclock_ms: int,
) -> RecoveryStats:
    recoverable = tuple(call for call in calls if call.recovery == "guided")
    ignored_hints = sum(1 for detail in agent_side if detail.get("kind") == "ignored_hint")
    recovered = max(0, len(recoverable) - ignored_hints)
    rate = None if not recoverable else recovered / len(recoverable)
    first_failure_index = next((index for index, call in enumerate(calls) if call.cls is not None), None)
    extra_calls = 0 if first_failure_index is None else max(0, len(calls) - first_failure_index - 1)
    return RecoveryStats(
        recoverable_failures=len(recoverable),
        recovered_failures=recovered,
        self_recovery_rate=rate,
        extra_calls=extra_calls,
        extra_tokens=extra_tokens,
        extra_wallclock_ms=extra_wallclock_ms,
    )


def _guidance_quality(calls: tuple[CallVerdict, ...]) -> float:
    failures = tuple(call for call in calls if call.cls is not None)
    if not failures:
        return 1.0
    values = []
    for call in failures:
        if call.cls == "B" or call.recovery == "guided":
            values.append(1.0)
        elif call.cls == "C":
            values.append(0.0)
        elif call.cls == "A":
            values.append(0.1)
        else:
            values.append(0.5)
    return sum(values) / len(values)


def _route_quality(calls: tuple[CallVerdict, ...]) -> float:
    if any(call.cls == "D" for call in calls):
        return 0.35
    failures = sum(1 for call in calls if call.cls is not None)
    return 1.0 / (1.0 + failures)


def _attribution_quality(calls: tuple[CallVerdict, ...]) -> float:
    charged_failures = tuple(call for call in calls if call.cls is not None)
    if not charged_failures:
        return 1.0
    penalty = sum(CLASS_SEVERITY_PENALTIES.get(call.cls or "", 0.0) for call in charged_failures)
    return max(0.0, 1.0 - (penalty / len(charged_failures)))


def _raw_record(record: object) -> dict[str, Any]:
    if isinstance(record, dict):
        return record
    return {
        "calls": getattr(record, "calls", ()),
        "agent_side": getattr(record, "agent_side", ()),
        "attempt": getattr(record, "attempt", None),
    }


def _call_verdict(raw: CallVerdict | dict[str, Any]) -> CallVerdict:
    if isinstance(raw, CallVerdict):
        return raw
    return CallVerdict(
        outcome=raw.get("outcome", ""),
        blame=raw.get("blame", ""),
        recovery=raw.get("recovery", ""),
        cls=raw.get("class", raw.get("cls")),
        subtype=raw.get("subtype"),
        evidence=raw.get("evidence", ""),
        probes=tuple(_probe(probe) for probe in raw.get("probes", ())),
    )


def _attempt_verdict(raw: AttemptVerdict | dict[str, Any] | None) -> AttemptVerdict | None:
    if raw is None or isinstance(raw, AttemptVerdict):
        return raw
    return AttemptVerdict(
        outcome=raw.get("outcome", ""),
        blame=raw.get("blame", ""),
        recovery=raw.get("recovery", ""),
        cls=raw.get("class", raw.get("cls")),
        subtype=raw.get("subtype"),
        evidence=raw.get("evidence", ""),
    )


def _probe(raw: Probe | dict[str, Any]) -> Probe:
    if isinstance(raw, Probe):
        return raw
    return Probe(
        kind=raw.get("kind", ""),
        ran=raw.get("ran", ""),
        result=raw.get("result", ""),
        conclusive=bool(raw.get("conclusive", False)),
    )
