"""Agent-side failure detectors for record-v2 attempts."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable

HINT_PATTERN = re.compile(r"did you mean\s*:?(?P<body>[^\n]+)", re.IGNORECASE)
SUGGESTION_PATTERN = re.compile(r"`([^`]+)`|\b([a-z][a-z0-9_]+)\b")


@dataclass(frozen=True)
class IgnoredHint:
    """A guided tool hint that the agent did not use immediately."""

    kind: str
    at_call: int
    ignored_by_next: bool
    hint: str
    suggestions: tuple[str, ...]
    next_argv: tuple[str, ...]
    window_argv: tuple[tuple[str, ...], ...]
    eventually_used: bool
    used_at_call: int | None
    detail: str

    def to_record(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "at_call": self.at_call,
            "ignored_by_next": self.ignored_by_next,
            "hint": self.hint,
            "suggestions": list(self.suggestions),
            "next_argv": list(self.next_argv),
            "window_argv": [list(argv) for argv in self.window_argv],
            "eventually_used": self.eventually_used,
            "used_at_call": self.used_at_call,
            "detail": self.detail,
        }


def detect_ignored_hints(calls: Iterable[dict[str, Any]], *, window: int = 3) -> list[dict[str, Any]]:
    """Return class-F details for hints not used in the next command.

    The strict boolean is ``ignored_by_next``.  The richer window records whether
    the suggestion appeared later, without erasing the fact that the tool gave a
    guided recovery path at the original call.
    """
    call_list = list(calls)
    findings: list[dict[str, Any]] = []
    for index, call in enumerate(call_list):
        hint = _hint_text(call)
        if not hint:
            continue
        suggestions = _suggestions(hint)
        if not suggestions:
            continue

        next_call = call_list[index + 1] if index + 1 < len(call_list) else None
        next_argv = tuple(next_call.get("argv", ())) if next_call else ()
        ignored_by_next = next_call is None or not _argv_mentions(next_argv, suggestions)
        if not ignored_by_next:
            continue

        end = min(len(call_list), index + 1 + window)
        window_calls = call_list[index + 1 : end]
        window_argv = tuple(tuple(item.get("argv", ())) for item in window_calls)
        used_at_call = _first_use(call_list, index + 1, suggestions)
        finding = IgnoredHint(
            kind="ignored_hint",
            at_call=index,
            ignored_by_next=True,
            hint=hint,
            suggestions=suggestions,
            next_argv=next_argv,
            window_argv=window_argv,
            eventually_used=used_at_call is not None,
            used_at_call=used_at_call,
            detail=_detail(index, suggestions, next_argv, used_at_call),
        )
        findings.append(finding.to_record())
    return findings


def _hint_text(call: dict[str, Any]) -> str | None:
    text = "\n".join(str(call.get(key, "")) for key in ("stderr", "stderr_head", "stdout", "stdout_head"))
    match = HINT_PATTERN.search(text)
    return match.group(0).strip() if match else None


def _suggestions(hint: str) -> tuple[str, ...]:
    _, _, tail = hint.lower().partition("did you mean")
    tokens: list[str] = []
    for quoted, bare in SUGGESTION_PATTERN.findall(tail):
        token = quoted or bare
        if token in {"did", "you", "mean", "try", "or", "and", "the", "a", "an"}:
            continue
        if token not in tokens:
            tokens.append(token)
    return tuple(tokens)


def _argv_mentions(argv: tuple[str, ...], suggestions: tuple[str, ...]) -> bool:
    command = " ".join(argv).lower()
    return any(suggestion.lower() in command for suggestion in suggestions)


def _first_use(calls: list[dict[str, Any]], start: int, suggestions: tuple[str, ...]) -> int | None:
    for index in range(start, len(calls)):
        if _argv_mentions(tuple(calls[index].get("argv", ())), suggestions):
            return index
    return None


def _detail(index: int, suggestions: tuple[str, ...], next_argv: tuple[str, ...], used_at_call: int | None) -> str:
    suggestion_text = ", ".join(suggestions)
    next_text = " ".join(next_argv) if next_argv else "<no next command>"
    if used_at_call is None:
        return f"hint at call {index} suggested {suggestion_text}; next command did not use it: {next_text}"
    return (
        f"hint at call {index} suggested {suggestion_text}; next command did not use it: {next_text}; "
        f"eventually used at call {used_at_call}"
    )
