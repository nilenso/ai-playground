"""Turns one attempt at a question into a number, plus a written explanation.

The explanation matters as much as the number here. GEPA improves things by
reading *why* something failed, so every score comes with the commands that
were run and what went wrong with them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import config
from .questions import Question
from .taxonomy import classify
from .trace import Call, Transcript


@dataclass
class Attempt:
    """Everything we know about one AI attempt at one question."""

    question_id: str
    repeat: int
    calls: list[Call]
    transcript: Transcript

    errors: list[tuple[str, str]] = field(default_factory=list)  # (label, command)
    used_download: bool = False
    unnecessary_download: bool = False
    recovered: bool = False

    @property
    def ok(self) -> bool:
        """Did the attempt run at all? False means a crash or a timeout."""
        return self.transcript.status == "ok"

    @property
    def completed(self) -> bool:
        return self.transcript.completed


def analyse(question: Question, calls: list[Call], transcript: Transcript, repeat: int) -> Attempt:
    attempt = Attempt(question.id, repeat, calls, transcript)

    downloads = [c for c in calls if c.subcommand == "download"]
    attempt.used_download = bool(downloads)
    # Reaching for the bulk download is only a mistake when a purpose-built
    # command existed and the AI didn't find it.
    attempt.unnecessary_download = bool(downloads) and not question.download_is_legitimate

    first_bad = None
    for i, call in enumerate(calls):
        label = classify(call)
        if label != "clean":
            attempt.errors.append((label, call.pretty()))
            if first_bad is None:
                first_bad = i

    # The tool's error messages are supposed to help the AI recover. If it did
    # recover, the message did its job, so we penalise that far less.
    if first_bad is not None:
        attempt.recovered = any(
            c.exit_code == 0 and classify(c) == "clean" for c in calls[first_bad + 1 :]
        )
    return attempt


def correctness(attempts: list[Attempt]) -> float:
    """How well the AI did, from 0 to 1.

    This is a stand-in. What we actually want to know is "did it build a
    command capable of answering the question", which needs expected-command
    data we don't have yet. Until then we approximate from what we can see.
    Named in config as CORRECTNESS_IMPL so two runs scored by different rules
    are never compared.
    """
    if not attempts:
        return 0.0
    total = 0.0
    for a in attempts:
        if not a.completed:
            continue  # scores zero
        score = 1.0
        if a.unnecessary_download:
            score -= 0.5
        if a.errors:
            score -= 0.1 if a.recovered else 0.3
        total += max(0.0, score)
    return total / len(attempts)


def efficiency(reference: float | None, actual: float) -> float:
    """Cost or time, compared against the unchanged tool. 0.5 means "same".

    Scored as a ratio rather than against an all-time best on purpose. Against
    a best, everything sits at or below the ceiling, so these terms could only
    ever punish — a genuinely faster tool would look identical to no change.
    """
    if not reference or actual <= 0:
        return 0.5
    return min(2.0, reference / actual) / 2.0


def objective(correct: float, tokens: float, wall: float) -> float:
    w = config.WEIGHTS
    return (
        w["correctness"] * correct
        + w["token_efficiency"] * tokens
        + w["wallclock"] * wall
    )


def feedback(question: Question, attempts: list[Attempt]) -> str:
    """The written half of the score: what the AI actually did, and what broke.

    This is handed to GEPA as its feedback. It is deliberately concrete —
    the exact commands and the exact error text — because that is what lets
    the improver work out what to change.
    """
    lines = [f'Question: "{question.question}"']

    usable = [a for a in attempts if a.ok]
    if not usable:
        lines.append("Every attempt crashed or timed out, so we learned nothing here.")
        return "\n".join(lines)

    a = usable[0]
    lines.append(f"Commands the AI ran ({len(a.calls)}):")
    if not a.calls:
        lines.append("  (none — it never called the tool at all)")
    for call in a.calls:
        mark = "ok " if classify(call) == "clean" else "BAD"
        lines.append(f"  [{mark}] {call.pretty()}")
        err = (call.stderr or "").strip()
        if err and classify(call) != "clean":
            first_lines = " / ".join(err.splitlines()[:3])
            lines.append(f"        -> {first_lines[:400]}")

    if a.unnecessary_download:
        lines.append(
            "PROBLEM: it fell back to the bulk `download` escape hatch even though a "
            "purpose-built command covers this. That usually means the right command "
            "was hard to find or hard to trust."
        )
    if a.errors:
        labels = ", ".join(sorted({label for label, _ in a.errors}))
        lines.append(f"PROBLEM: {len(a.errors)} failed command(s): {labels}.")
        lines.append(
            "It recovered afterwards." if a.recovered else "It never recovered."
        )
    if not a.completed:
        lines.append("PROBLEM: it never produced an answer.")
    if not a.errors and not a.unnecessary_download and a.completed:
        lines.append("This one went cleanly.")

    if question.notes:
        lines.append(f"Intended approach: {question.notes.strip()}")
    lines.append(f"Answer given: {a.transcript.final_answer.strip()[:300]}")
    return "\n".join(lines)
