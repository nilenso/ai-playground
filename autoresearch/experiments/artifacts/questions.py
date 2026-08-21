"""Load and validate a question bank, shared by the runner and the scorer.

A bank is a YAML list of questions. Each needs an `id` and a `question`;
`tier`, `place`, and `download_is_legitimate` are optional and default to
0, absent, and False respectively.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REQUIRED_KEYS = ("id", "question")


def load_questions(path) -> list[dict]:
    """Parse a question bank, raising SystemExit with a usable message on any problem."""
    path = Path(path)
    if not path.exists():
        raise SystemExit(f"[eval] question file not found: {path}")
    try:
        data = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise SystemExit(f"[eval] {path} is not valid YAML: {exc}") from exc

    if not isinstance(data, list):
        raise SystemExit(f"[eval] {path} must contain a YAML list of questions")
    if not data:
        raise SystemExit(f"[eval] {path} contains no questions")

    seen: set[str] = set()
    for i, q in enumerate(data):
        if not isinstance(q, dict):
            raise SystemExit(f"[eval] {path}: question {i} is not a mapping")
        missing = [k for k in REQUIRED_KEYS if not q.get(k)]
        if missing:
            raise SystemExit(f"[eval] {path}: question {i} is missing {', '.join(missing)}")
        if q["id"] in seen:
            raise SystemExit(f"[eval] {path}: duplicate question id {q['id']!r}")
        seen.add(q["id"])
    return data


def question_map(path) -> dict[str, dict]:
    """The same bank keyed by question id, for matching run directories."""
    return {q["id"]: q for q in load_questions(path)}
