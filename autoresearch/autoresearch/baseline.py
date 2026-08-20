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
from .questions import Question
from .score import Attempt


@dataclass
class Reading:
    """What the unchanged tool cost us on one question."""

    tokens: float
    duration_ms: float
    correctness: float


def _summarise(attempts: list[Attempt]) -> Reading | None:
    usable = [a for a in attempts if a.ok]
    if not usable:
        return None  # every try failed; this question tells us nothing
    from .score import correctness

    return Reading(
        tokens=statistics.mean(a.transcript.usage.total_tokens for a in usable),
        duration_ms=statistics.mean(a.transcript.usage.duration_ms for a in usable),
        correctness=correctness(usable),
    )


def path_for(sha: str) -> Path:
    return config.ROOT / "experiments" / "baselines" / f"{sha}.json"


def load(sha: str) -> dict[str, Reading] | None:
    path = path_for(sha)
    if not path.exists():
        return None
    raw = json.loads(path.read_text())
    return {k: Reading(**v) for k, v in raw["questions"].items()}


def measure(questions: list[Question], tree: Path, sha: str,
            keep_dir: Path | None = None) -> dict[str, Reading]:
    """Run every question against the unchanged tool and save the result."""
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
                "pinned": False,  # the tool picks the latest snapshot itself
                # The legacy name deliberately, not the run's scorer name.
                # The `correctness` figures below come from
                # `score.correctness()`, which is frozen at proxy-v1 precisely
                # so baselines stay comparable across scorer changes. Stamping
                # the current scorer here would label the file with rules its
                # numbers were never computed under -- and a baseline that
                # misreports how it was measured is worse than none, because
                # it is trusted.
                "correctness_impl": config.LEGACY_CORRECTNESS_IMPL,
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
