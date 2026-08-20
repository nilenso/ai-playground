"""Reads the two things a single question leaves behind.

1. The command log: every `botmap ...` the AI ran, with what came back.
2. The transcript: what the AI finally said, and what it cost.

Together these are the raw evidence. The score is derived from them, and the
same evidence is handed to GEPA as feedback, which is the point — a plain-text
"here is what went wrong" is far more useful to the improver than a number.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Call:
    """One `botmap ...` command the AI ran."""

    argv: list[str]
    exit_code: int
    stdout: str
    stderr: str
    duration: float = 0.0

    @property
    def subcommand(self) -> str:
        """The verb, e.g. 'count'. Empty string when there wasn't one.

        Empty rather than None so callers can compare it to a name without
        checking for None first.
        """
        for token in self.argv:
            if not token.startswith("-"):
                return token
        return ""

    def pretty(self) -> str:
        return "botmap " + " ".join(self.argv)


@dataclass(frozen=True)
class Usage:
    """What one question cost us."""

    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    duration_ms: int = 0
    num_turns: int = 0

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )


# What the CLI says when the subscription has nothing left to spend. Checked
# against the result event's text rather than its status, because the status is
# no help: the event arrives with `is_error` true and `subtype` "success" --
# the agent process exited cleanly, it simply never got to do anything.
#
# "session limit" is the wording seen in the real transcripts. The others are
# not confirmed, and are matched anyway because the two directions cost very
# differently: spotting quota exhaustion that did not happen wastes a run,
# while missing one that did poisons every measurement after it.
_QUOTA_MARKERS = ("session limit", "usage limit", "rate limit")


@dataclass(frozen=True)
class Transcript:
    """How the AI's attempt ended."""

    final_answer: str = ""
    completed: bool = False
    status: str = "error"  # "ok" or "error"
    usage: Usage = field(default_factory=Usage)
    # The run ran out of quota rather than the tool doing anything wrong.
    # Tracked apart from `status` because at the scoring layer the two are
    # indistinguishable, and treating this as an ordinary failure would charge
    # a candidate for something it had no part in.
    quota_exhausted: bool = False


def parse_calls(path: Path) -> list[Call]:
    if not path.exists():
        return []
    calls: list[Call] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            # A half-written last line means the run was killed mid-write.
            # Skip it rather than losing every command before it.
            continue
        calls.append(
            Call(
                argv=list(d.get("argv") or []),
                exit_code=int(d.get("exit_code") or 0),
                stdout=d.get("stdout") or "",
                stderr=d.get("stderr") or "",
                duration=float(d.get("duration") or 0.0),
            )
        )
    return calls


def parse_transcript(path: Path) -> Transcript:
    if not path.exists():
        return Transcript()

    result = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            result = event

    if result is None:
        return Transcript()

    answer = result.get("result") or ""
    errored = bool(result.get("is_error"))
    quota = errored and any(m in answer.lower() for m in _QUOTA_MARKERS)
    u = result.get("usage") or {}
    return Transcript(
        final_answer=answer,
        completed=(not errored) and bool(answer),
        status="error" if errored else "ok",
        quota_exhausted=quota,
        usage=Usage(
            cost_usd=float(result.get("total_cost_usd") or 0.0),
            input_tokens=int(u.get("input_tokens") or 0),
            output_tokens=int(u.get("output_tokens") or 0),
            cache_read_tokens=int(u.get("cache_read_input_tokens") or 0),
            cache_creation_tokens=int(u.get("cache_creation_input_tokens") or 0),
            duration_ms=int(result.get("duration_ms") or 0),
            num_turns=int(result.get("num_turns") or 0),
        ),
    )
