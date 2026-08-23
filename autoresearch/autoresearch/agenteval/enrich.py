"""Enrich retained record-v2 files with post-agent differential probes."""

from __future__ import annotations

from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
from typing import Any

from autoresearch import runner as agent_runner
from autoresearch.trace import parse_calls

from .contract import write as write_record
from .probe import ProbeBudget, ProbeObservation, probe_call
from .record import build_record
from .taxonomy import classify


def enrich_run(run_dir: str | Path, botmap_repo: str | Path, *, max_probe_calls: int = 8, timeout_s: int = 120) -> dict[str, Any]:
    """Run CLI-only probes for retained attempts and rewrite record-v2 files.

    The agent transcript is not touched.  Probes run after the attempt, matching
    the measurement design in docs/plan.md.
    """
    root = Path(run_dir)
    repo = Path(botmap_repo)
    runner = botmap_runner(repo, timeout_s=timeout_s)
    summary = {"attempts": 0, "calls_seen": 0, "calls_probed": 0, "probe_calls": 0}

    for attempt_dir in sorted((root / "attempts").iterdir() if (root / "attempts").exists() else []):
        commands = attempt_dir / "commands.jsonl"
        transcript = attempt_dir / "transcript.jsonl"
        if not commands.exists():
            continue
        calls = parse_calls(commands)
        record = build_record(_attempt_from_parts(attempt_dir.name, calls, transcript), transcript_path=transcript)
        enriched_calls = []
        for call, call_record in zip(calls, record.calls, strict=True):
            summary["calls_seen"] += 1
            if _should_probe(call_record):
                budget = ProbeBudget(max_calls=max_probe_calls)
                result = probe_call(call, runner, budget=budget)
                summary["calls_probed"] += 1
                summary["probe_calls"] += budget.used
                verdict = classify(call, result.probes)
                call_record = dict(call_record)
                call_record.update(
                    outcome=verdict.outcome,
                    blame=verdict.blame,
                    recovery=verdict.recovery,
                    **{"class": verdict.cls},
                    subtype=verdict.subtype,
                    evidence=verdict.evidence,
                    probes=[asdict(probe) for probe in result.probes],
                )
            enriched_calls.append(call_record)
        record = type(record)(
            schema=record.schema,
            question_id=record.question_id,
            repeat=record.repeat,
            calls=tuple(enriched_calls),
            agent_side=record.agent_side,
            tools_used=record.tools_used,
            botmap_calls=record.botmap_calls,
            answer=record.answer,
            attempt=record.attempt,
        )
        write_record(attempt_dir / "record-v2.json", record)
        summary["attempts"] += 1
    return summary


def botmap_runner(repo: Path, *, timeout_s: int = 120):
    """Return a Probe runner that executes botmap in the supplied checkout."""
    python = agent_runner.venv_python(repo)

    def run(argv: tuple[str, ...]) -> ProbeObservation:
        env = dict(os.environ)
        process = subprocess.run(
            [python, "-m", "botmap", *argv],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        return ProbeObservation(exit_code=process.returncode, stdout=process.stdout, stderr=process.stderr)

    return run


def _should_probe(call: dict[str, Any]) -> bool:
    if call.get("class") == "C":
        return True
    argv = call.get("argv") or []
    return "--top" in argv or any(str(item).startswith("--top=") for item in argv)


def _attempt_from_parts(name: str, calls, transcript_path: Path):
    from autoresearch.score import Attempt
    from autoresearch.trace import parse_transcript

    question_id, _, repeat_text = name.rpartition("__r")
    repeat = int(repeat_text) if repeat_text.isdigit() else 1
    return Attempt(question_id=question_id, repeat=repeat, calls=calls, transcript=parse_transcript(transcript_path))
