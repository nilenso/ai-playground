"""Loads the list of map questions we grade against.

Checked strictly on load. A typo found three hours into a run is expensive, so
we fail immediately and say which entry is wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import config


@dataclass(frozen=True)
class Question:
    """One question we ask the AI, plus what we know about it."""

    id: str
    question: str
    tier: int = 0
    place: str | None = None
    # True when there is genuinely no purpose-built command for this, so
    # falling back to the bulk-download escape hatch isn't the AI's fault.
    download_is_legitimate: bool = False
    notes: str = ""
    extra: dict = field(default_factory=dict)


def load(path: Path | None = None) -> list[Question]:
    path = Path(path or config.QUESTIONS)
    try:
        raw = yaml.safe_load(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"no question bank at {path}")
    except yaml.YAMLError as exc:
        raise SystemExit(f"{path} is not valid YAML: {exc}") from exc

    if not isinstance(raw, list):
        raise SystemExit(f"{path} must be a YAML list of questions")
    if not raw:
        raise SystemExit(f"{path} has no questions in it")

    seen: set[str] = set()
    out: list[Question] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SystemExit(f"{path}[{i}] is not a mapping")
        for key in ("id", "question"):
            if not item.get(key):
                raise SystemExit(f"{path}[{i}] is missing '{key}'")
        qid = str(item["id"])
        # Run folders are named "<id>__r<n>", so an id containing "__" would
        # make them impossible to read back.
        if "__" in qid:
            raise SystemExit(f"{path}[{i}]: id {qid!r} must not contain '__'")
        if qid in seen:
            raise SystemExit(f"{path}[{i}]: duplicate id {qid!r}")
        seen.add(qid)

        known = {"id", "question", "tier", "place", "download_is_legitimate", "notes"}
        out.append(
            Question(
                id=qid,
                question=str(item["question"]),
                tier=int(item.get("tier") or 0),
                place=item.get("place"),
                download_is_legitimate=bool(item.get("download_is_legitimate", False)),
                notes=str(item.get("notes") or ""),
                extra={k: v for k, v in item.items() if k not in known},
            )
        )
    return out


def split(questions: list[Question], holdout: float = 0.2) -> tuple[list[Question], list[Question]]:
    """Split into questions we optimise on, and questions we check against.

    The held-out set is what tells us whether an improvement is real or whether
    we just memorised the training questions. We take every Nth question rather
    than shuffling, so the split is identical every run — otherwise two runs
    aren't comparable.

    We also make sure both halves cover every difficulty tier, so the held-out
    score isn't accidentally all-easy or all-hard.
    """
    if not 0 < holdout < 1:
        raise ValueError("holdout must be between 0 and 1")

    by_tier: dict[int, list[Question]] = {}
    for q in sorted(questions, key=lambda q: q.id):
        by_tier.setdefault(q.tier, []).append(q)

    every_nth = max(2, round(1 / holdout))
    train, val = [], []
    for tier_questions in by_tier.values():
        for i, q in enumerate(tier_questions):
            (val if i % every_nth == every_nth - 1 else train).append(q)

    # A held-out set of nothing would silently disable the whole check.
    if not val:
        val = [train.pop()]
    return train, val
