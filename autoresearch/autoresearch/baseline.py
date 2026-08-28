"""Measures the unchanged tool once, so we have something to compare against.

Cost and speed are scored as "better or worse than the tool as it is today".
That needs a reading of how the tool performs before we change anything.

This is the expensive part of the whole system, so we do it once per commit and
save it. Later runs reuse the saved numbers.
"""

from __future__ import annotations

import json
import statistics
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config, runner
from .agenteval.record import build_record
from .agenteval.score import score_record
from .questions import Question
from .score import Attempt


@dataclass
class Reading:
    """What the unchanged tool cost us on one question."""

    tokens: float
    duration_ms: float
    correctness: float


def _summarise(attempts: list[Attempt]) -> Reading | None:
    measured = [
        (attempt, score_record(build_record(attempt), completed=attempt.completed))
        for attempt in attempts
    ]
    usable = [(attempt, score) for attempt, score in measured if not score.excluded]
    if not usable:
        return None  # every try failed outside the tool; this question tells us nothing

    return Reading(
        tokens=statistics.mean(attempt.transcript.usage.total_tokens for attempt, _ in usable),
        duration_ms=statistics.mean(attempt.transcript.usage.duration_ms for attempt, _ in usable),
        correctness=statistics.mean(score.breakdown.correctness_recoverability for _, score in usable),
    )


def path_for(sha: str) -> Path:
    return config.ROOT / "experiments" / "baselines" / f"{sha}.json"


def attempts_dir(sha: str) -> Path:
    """Where a baseline's raw attempts are kept.

    Beside the numbers they produced, rather than under a run, because a
    baseline belongs to a commit and is read by every run at that commit.
    """
    return config.ROOT / "experiments" / "baselines" / f"{sha}-attempts"


def load(sha: str) -> dict[str, Reading] | None:
    path = path_for(sha)
    if not path.exists():
        return None
    raw = json.loads(path.read_text())
    return {k: Reading(**v) for k, v in raw["questions"].items()}


def saved_release(sha: str) -> str | None:
    """Which map-data release these numbers were taken on.

    None when there is no baseline, or when it was written before we started
    recording this -- those files cannot be checked, only re-measured.
    """
    path = path_for(sha)
    if not path.exists():
        return None
    return json.loads(path.read_text()).get("release")


def measure(questions: list[Question], tree: Path, sha: str,
            keep_dir: Path | None = None) -> dict[str, Reading]:
    """Run every question against the unchanged tool and save the result.

    Raw attempts are kept by default, which they are NOT for candidates. The
    asymmetry is deliberate: a baseline is 60 attempts and a GEPA run is
    hundreds, so retention is cheap here and expensive there.

    It has already paid for itself twice over, in both cases for something
    nobody foresaw when the attempts were kept -- once to verify a second
    scorer could safely share this baseline, and once to derive a noise floor
    from the repeat-pairs, which replaced a whole second measurement worth
    about $15 and two hours. A baseline is measured once and read by
    everything downstream, so throwing its evidence away is the expensive
    choice, not the cheap one.
    """
    keep_dir = keep_dir or attempts_dir(sha)
    readings: dict[str, Reading] = {}
    skipped: list[str] = []

    for i, q in enumerate(questions, 1):
        print(f"[baseline] {i}/{len(questions)} {q.id}", flush=True)
        reading = _summarise(runner.ask_repeatedly(q, tree, keep_dir=keep_dir))
        if reading is None:
            skipped.append(q.id)
            continue
        readings[q.id] = reading

    out = path_for(sha)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "sha": sha,
                "release_requested": config.requested_release(),
                # Which snapshot these numbers were actually taken on. Asked of
                # the copy we just measured, not of your checkout. Without this
                # a stale yardstick is undetectable: the tool is unpinned, so
                # the data can move under a baseline with nothing looking wrong.
                "release": config.detected_release(tree),
                # Which till paid for these numbers, and which host served
                # them. Same lesson as `release`: a baseline and a candidate
                # measured on different paths are not comparable, and without
                # this nothing would ever say so.
                "agent_path": config.agent_path(),
                "agent_provider": config.agent_provider(),
                "agent_model": config.AGENT_MODEL,
                "pinned": False,  # the tool picks the latest snapshot itself
                "correctness_impl": config.CORRECTNESS_IMPL,
                "repeats": config.REPEATS,
                "skipped": skipped,
                "questions": {k: asdict(v) for k, v in readings.items()},
            },
            indent=2,
        )
    )
    if skipped:
        print(f"[baseline] couldn't measure: {', '.join(skipped)}")
    return readings
