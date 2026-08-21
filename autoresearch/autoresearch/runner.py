"""Asks the AI one map question and records everything it did.

This is the actual measurement. We set up a scratch folder, put the tool's
instructions where the AI will read them, put our command logger in front of
the real tool, then let the AI loose with a shell and nothing else.

We never tell it which commands to use. Working that out *is* the test.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config
from .questions import Question
from .score import Attempt, analyse
from .trace import parse_calls, parse_transcript


def venv_python(tree: Path) -> str:
    """The interpreter belonging to this copy of the tool.

    Important: it must be this copy's, not your main one. Otherwise we'd
    measure the unchanged tool and never see the candidate's effect.
    """
    candidate = tree / ".venv" / "bin" / "python"
    return str(candidate) if candidate.exists() else "python3"


def _install_instructions(workdir: Path, tree: Path) -> None:
    """Copy the tool's instruction file to where the AI will pick it up.

    Read from the private copy, not from the installed package. If we read the
    installed one, a candidate that rewrites the instructions would change
    nothing — and the result would look like an honest "no effect" instead of
    a broken measurement.
    """
    src = tree / config.lever_files("prompt")[0]
    dest = workdir / ".claude" / "skills" / "botmap" / "SKILL.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def ask(question: Question, tree: Path, repeat: int, keep_dir: Path | None = None) -> Attempt:
    """Ask one question once. Returns what happened."""
    workdir = Path(tempfile.mkdtemp(prefix=f"oa-{question.id}-"))
    log_path = workdir / "commands.jsonl"
    transcript_path = workdir / "transcript.jsonl"
    stderr_path = workdir / "claude-stderr.log"
    python = venv_python(tree)

    env = dict(os.environ)
    env.update(
        AUTORESEARCH_LOG=str(log_path),
        AUTORESEARCH_PYTHON=python,
        # Passed through in case the tool ever honours it. It does not today,
        # so runs are not pinned to a snapshot.
        **({"BOTMAP_RELEASE": config.requested_release()}
           if config.requested_release() else {}),
        # Our logger first, so every `botmap` the AI runs goes through it and
        # lands in this copy of the tool rather than the real one.
        PATH=os.pathsep.join([str(config.SHIM.parent), str(Path(python).parent), env.get("PATH", "")]),
    )

    try:
        _install_instructions(workdir, tree)
        # Same model either way. On the fallback path it has to be named in
        # full, because `sonnet` is the subscription's alias and OpenRouter
        # offers several Sonnets -- picking the wrong one would measure a
        # model difference and report it as a path difference.
        model = (config.OPENROUTER_MODEL if config.agent_path() == "openrouter"
                 else config.AGENT_MODEL)
        cmd = [
            "claude", "-p", question.question,
            "--output-format", "stream-json", "--verbose",
            "--model", model,
            "--permission-mode", "bypassPermissions",
            "--allowedTools", "Bash",
        ]
        with open(transcript_path, "w") as out, open(stderr_path, "w") as err:
            try:
                subprocess.run(cmd, cwd=workdir, env=env, stdout=out, stderr=err,
                               timeout=config.RUN_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                err.write(f"\n[autoresearch] gave up after {config.RUN_TIMEOUT_S}s\n")
            except FileNotFoundError:
                raise SystemExit("`claude` isn't on PATH — install Claude Code first")

        attempt = analyse(
            question, parse_calls(log_path), parse_transcript(transcript_path), repeat
        )

        # Keeping the raw files is optional because GEPA runs hundreds of
        # these; saving them all would fill the disk for little benefit.
        if keep_dir is not None:
            keep = keep_dir / f"{question.id}__r{repeat}"
            keep.mkdir(parents=True, exist_ok=True)
            for name, path in (("commands.jsonl", log_path),
                               ("transcript.jsonl", transcript_path),
                               ("claude-stderr.log", stderr_path)):
                if path.exists():
                    shutil.copy(path, keep / name)
        return attempt
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def ask_repeatedly(question: Question, tree: Path, repeats: int | None = None,
                   keep_dir: Path | None = None) -> list[Attempt]:
    """Ask the same question a few times, so one flaky network call doesn't
    throw the question away. Not an average — two tries can't support that."""
    n = config.REPEATS if repeats is None else repeats
    return [ask(question, tree, r, keep_dir) for r in range(1, n + 1)]
