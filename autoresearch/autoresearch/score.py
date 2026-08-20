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

    # Commands that failed before the first one that worked. "How hard was it
    # to find the right command", counted rather than inferred.
    wasted: int = 0
    # Commands that exited 0 while telling the assistant its filter was wrong.
    # Counted separately from `errors` because the assistant cannot see these:
    # to it they look like a successful query that found nothing.
    silent_failures: int = 0
    # Commands that failed reaching the data rather than because they were
    # wrong. Kept out of `errors` entirely: they say nothing about the tool,
    # and charging them to a candidate would score our connection.
    network_failures: int = 0

    @property
    def ok(self) -> bool:
        """Did the attempt run at all? False means a crash or a timeout."""
        return self.transcript.status == "ok"

    @property
    def completed(self) -> bool:
        return self.transcript.completed

    @property
    def network_bound(self) -> bool:
        """Did the network, rather than the tool, decide how this went?

        True when not one command got through cleanly and at least one failed
        on the way to the data. Such an attempt cannot be scored in either
        direction: the assistant never found out what the tool would have done.

        This matters more than it looks. Excluding network failures from the
        penalties, without also refusing to score an attempt made entirely of
        them, would hand full marks to a run where nothing worked at all --
        no errors on the record, no wasted commands, and a final answer saying
        it could not reach the data.
        """
        return self.network_failures > 0 and not any(
            classify(c) == "clean" for c in self.calls
        )


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
        if label == "clean":
            continue
        if label == "network_failure":
            attempt.network_failures += 1
            continue
        attempt.errors.append((label, call.pretty()))
        if first_bad is None:
            first_bad = i

    attempt.silent_failures = sum(
        1 for label, _ in attempt.errors if label == "bad_category_value"
    )

    # Everything that failed before the first command that actually worked. If
    # nothing ever worked, every failure counts -- the assistant never found
    # its way, which is the case we most want to punish.
    first_good = next(
        (i for i, c in enumerate(calls) if c.exit_code == 0 and classify(c) == "clean"),
        None,
    )
    considered = calls if first_good is None else calls[:first_good]
    # A command the network ate was not a wrong turn by the assistant, so it
    # does not count against the path it took.
    attempt.wasted = sum(
        1 for c in considered if classify(c) not in ("clean", "network_failure")
    )

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


def _allowance(actual: float, free: int) -> float:
    """Full marks up to `free`, then decaying. Never negative, never zero.

    A ratio rather than a subtraction, so the penalty keeps its shape as the
    numbers grow: twice the allowance always scores 0.5, whether the allowance
    is three commands or thirty. A subtraction would fall off a cliff instead,
    and GEPA cannot climb a cliff -- past the bottom every candidate would look
    equally bad and the gradient it needs would be gone.
    """
    if actual <= free:
        return 1.0
    return free / actual


def struggle(attempts: list[Attempt]) -> float:
    """How hard the assistant had to work, from 0 (flailing) to 1 (straight there).

    Separate from `correctness` because they answer different questions.
    Correctness asks "did it get there". This asks "what did getting there cost
    the assistant" -- and two candidates that both get there are not equally
    good if one of them took nine commands and four dead ends.

    **Gated on completion.** An attempt that never answered scores zero here,
    and that gate is load-bearing rather than tidy: the command and turn counts
    reward doing less, so without it the highest-scoring behaviour would be to
    give up immediately. Combined with the gate, the only way to score well is
    to answer the question *and* take a short path to it.

    That leaves one gap the gate cannot close: an assistant that answers fast
    and confidently wrong. That is exactly the silent-failure case, which is
    why `silent` carries the heaviest weight of the four.
    """
    if not attempts:
        return 0.0

    w = config.STRUGGLE_WEIGHTS
    total = 0.0
    for a in attempts:
        if not a.completed:
            continue  # scores zero: see the gate, above

        # Binary rather than graded. One confident wrong answer is the whole
        # failure; a second one does not make it meaningfully worse.
        silent = 0.0 if a.silent_failures else 1.0
        # A smooth decay rather than the allowance curve: there is no free
        # allowance for a wrong command, but there must still be a gradient
        # between one wrong command and five, or GEPA cannot tell a partial
        # improvement from none at all.
        waste = 1.0 / (1.0 + a.wasted)

        commands = _allowance(len(a.calls), config.FREE_COMMANDS)
        turns = _allowance(a.transcript.usage.num_turns, config.FREE_TURNS)
        path = (commands + turns) / 2

        # Only meaningful when something went wrong. An attempt with no errors
        # gets full marks here rather than a free pass it did not earn -- the
        # `waste` term is what rewards having no errors, so scoring recovery
        # as 1.0 keeps the two from counting the same thing twice.
        recovery = 1.0 if (not a.errors or a.recovered) else 0.0

        total += (w["silent"] * silent + w["waste"] * waste
                  + w["path"] * path + w["recovery"] * recovery)
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


def objective(correct: float, struggled: float, tokens: float, wall: float) -> float:
    w = config.WEIGHTS
    return (
        w["correctness"] * correct
        + w["struggle"] * struggled
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

    # Stated first, and in the strongest terms available, because it is the
    # failure the assistant itself cannot see. Everything below is something it
    # noticed; this is the one it reported as fact.
    if a.silent_failures:
        lines.append(
            f"WORST PROBLEM: {a.silent_failures} command(s) exited successfully while "
            "the result was wrong -- the tool returned 0 rows because the filter value "
            "was not one it knows. The assistant had no way to tell that apart from "
            "'there genuinely are none here', so it reported a confident wrong answer. "
            "A command that cannot honour a filter must say so on stderr and fail, or "
            "name the values it does accept."
        )

    # Effort, stated plainly whether or not it was excessive, so the improver
    # can see the difference between a change that helped and one that merely
    # did not hurt.
    turns = a.transcript.usage.num_turns
    lines.append(
        f"Effort: {len(a.calls)} command(s), {turns} turn(s), "
        f"{a.wasted} failed before the first one that worked."
    )
    if a.wasted:
        lines.append(
            f"PROBLEM: it took {a.wasted} wrong command(s) before finding one that "
            "worked. Shortening that path -- by making the first thing an assistant "
            "reasonably tries succeed, or by naming the right command in the error -- "
            "is worth as much as fixing an outright failure."
        )

    if a.network_failures:
        lines.append(
            f"NOTE: {a.network_failures} command(s) failed on the way to the data -- "
            "network timeouts, not the tool getting anything wrong. They are excluded "
            "from the score. Do NOT try to fix these: retry logic or error handling "
            "added for them would be tuning the tool to our connection on the day, "
            "which is not what is being measured and will not survive the next run."
        )

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
    if (not a.errors and not a.unnecessary_download and a.completed
            and not a.wasted and not a.network_failures):
        lines.append("This one went cleanly.")

    if question.notes:
        lines.append(f"Intended approach: {question.notes.strip()}")
    lines.append(f"Answer given: {a.transcript.final_answer.strip()[:300]}")
    return "\n".join(lines)
