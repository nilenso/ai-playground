"""Class-weighted scoring for the shared agent evaluator.

Weights are deliberately placeholders until the first class distribution exists.
The constants are named so Phase 5 can tune them from evidence rather than from
preference.  TODO(phase-5): set these from the observed class histogram.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .contract import AttemptVerdict, CallVerdict

W_CORRECT = 0.60  # TODO(phase-5): tune after the first class distribution.
W_RECOVERY = 0.25  # TODO(phase-5): tune after the first class distribution.
W_EFFORT = 0.15  # TODO(phase-5): tune after the first class distribution.

CLASS_PENALTIES = {
    "A": 0.35,
    "B": 0.02,
    "C": 0.85,
    "D": 0.45,
    "E": 0.0,
    "F": 0.0,
}


@dataclass(frozen=True)
class Score:
    value: float | None
    excluded: bool
    charged: tuple[CallVerdict, ...]
    recorded_not_charged: tuple[CallVerdict, ...]
    environment: tuple[CallVerdict, ...]
    attempt_environment: AttemptVerdict | None = None


def score_attempt(
    calls: Iterable[CallVerdict],
    *,
    attempt: AttemptVerdict | None = None,
    agent_side: Iterable[dict] = (),
) -> Score:
    """Score one attempt.

    Class E is excluded.  Class F and explicit agent-side details are recorded
    but not charged to the tool.  Class B costs very little and contributes to
    recovery quality.  Class C dominates the outcome term.
    """
    call_tuple = tuple(calls)
    environment = tuple(call for call in call_tuple if call.cls == "E")
    recorded_not_charged = tuple(call for call in call_tuple if call.cls == "F")
    charged = tuple(call for call in call_tuple if call.cls not in {"E", "F"})

    if attempt is not None and attempt.cls == "E" and not charged:
        return Score(
            value=None,
            excluded=True,
            charged=(),
            recorded_not_charged=recorded_not_charged,
            environment=environment,
            attempt_environment=attempt,
        )

    if not charged:
        return Score(
            value=1.0,
            excluded=False,
            charged=(),
            recorded_not_charged=recorded_not_charged,
            environment=environment,
            attempt_environment=attempt if attempt and attempt.cls == "E" else None,
        )

    outcome = _outcome_quality(charged)
    recovery = _recovery_quality(charged, tuple(agent_side))
    effort = _effort_quality(charged)
    value = W_CORRECT * outcome + W_RECOVERY * recovery + W_EFFORT * effort
    return Score(
        value=max(0.0, min(1.0, value)),
        excluded=False,
        charged=charged,
        recorded_not_charged=recorded_not_charged,
        environment=environment,
        attempt_environment=attempt if attempt and attempt.cls == "E" else None,
    )


def _outcome_quality(calls: tuple[CallVerdict, ...]) -> float:
    penalty = sum(CLASS_PENALTIES.get(call.cls or "", 0.0) for call in calls)
    return max(0.0, 1.0 - penalty)


def _recovery_quality(calls: tuple[CallVerdict, ...], agent_side: tuple[dict, ...]) -> float:
    failures = [call for call in calls if call.cls is not None]
    if not failures:
        return 1.0

    guided = sum(1 for call in failures if call.recovery == "guided")
    base = guided / len(failures)

    # The tool offered usable guidance; if the agent ignored it, that is
    # recorded as class-F-shaped evidence and should not become a tool charge.
    ignored_hint = any(detail.get("kind") == "ignored_hint" for detail in agent_side)
    return base if ignored_hint else base


def _effort_quality(calls: tuple[CallVerdict, ...]) -> float:
    non_clean = sum(1 for call in calls if call.cls is not None)
    return 1.0 / (1.0 + non_clean)
