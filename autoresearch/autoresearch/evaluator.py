"""Scores one candidate version of the tool on one question, for GEPA.

GEPA's loop is: propose a new version of a file, score it, keep what's better,
repeat. This module is the "score it" half.

Two things it returns, and the second is the interesting one:

- a number, so GEPA knows whether the candidate is better;
- the commands the AI actually ran and the errors it hit, in plain text, so
  GEPA can work out *what to change next*. That written feedback is the whole
  reason GEPA needs fewer attempts than trial and error.
"""

from __future__ import annotations

import statistics
import subprocess
from dataclasses import asdict
from pathlib import Path

import gepa.optimize_anything as oa

from . import config, runner
from .agenteval import score as agenteval_score
from .agenteval.explain import explain
from .agenteval.record import build_record
from .baseline import Reading
from .questions import Question
from .worktree import Pool


class Evaluator:
    """Applies a candidate to a private copy of the tool, then grades it."""

    def __init__(self, lever: str, pool: Pool, reference: dict[str, Reading],
                 keep_dir: Path | None = None):
        self.lever = lever
        self.pool = pool
        self.reference = reference
        self.keep_dir = keep_dir
        self.calls = 0

    # -- cheap checks -----------------------------------------------------
    # Each real evaluation costs about $0.50 and several minutes. A candidate
    # that can't even start is worth catching in one second instead.

    def _broken(self, tree: Path) -> str | None:
        """Return why the candidate is unusable, or None if it looks fine."""
        python_files = [f for f in config.lever_files(self.lever, self.pool.files)
                        if f.endswith(".py")]
        if not python_files:
            return None  # the instructions file is prose; nothing to compile

        # Check every file in the lever, not just the one that changed — a
        # candidate that edits filters.py can just as easily break the import
        # that cli.py depends on.
        compiled = subprocess.run(
            [runner.venv_python(tree), "-m", "py_compile", *[str(tree / f) for f in python_files]],
            capture_output=True, text=True,
        )
        if compiled.returncode != 0:
            return f"A file has a Python syntax error:\n{compiled.stderr.strip()[:800]}"

        # It compiles — but does the tool still start? A bad import or a
        # malformed command definition only shows up when it runs.
        started = subprocess.run(
            [runner.venv_python(tree), "-m", "botmap", "--help"],
            cwd=tree, capture_output=True, text=True, timeout=60,
        )
        if started.returncode != 0:
            return f"The tool won't start:\n{started.stderr.strip()[:800]}"
        return None

    # -- the evaluator GEPA calls ----------------------------------------

    def __call__(self, candidate: dict[str, str], example: Question) -> tuple[float, dict]:
        self.calls += 1
        tree = self.pool.acquire()
        # Wipe the previous candidate before laying down this one. Copies are
        # reused across hundreds of evaluations, so without this a score could
        # reflect leftovers from an earlier candidate rather than this one --
        # and a broken candidate could poison every evaluation after it.
        #
        # GEPA happens to hand us every file each time, changed or not, so
        # nothing leaks today. But that is its business, not ours: this is the
        # one invariant the whole measurement rests on, and it costs
        # milliseconds to own it here instead of inheriting it.
        self.pool.reset(tree)
        self.pool.write_candidate(tree, self.lever, candidate)

        problem = self._broken(tree)
        if problem is not None:
            oa.log(problem)
            oa.log("Scored zero without asking the question, because nothing would run.")
            return 0.0, {"Blocked": problem}

        attempts = runner.ask_repeatedly(example, tree, keep_dir=self.keep_dir)
        measured = [_measure_attempt(a, self.reference.get(example.id)) for a in attempts]
        usable = [item for item in measured if not item["score"].excluded]

        # Every try crashed, timed out, or hit an environment failure. That's a
        # broken measurement, not a bad candidate, so say so rather than
        # blaming the candidate.
        if not usable:
            for item in measured:
                oa.log(explain(item["record"]))
            oa.log(f"Could not measure {example.id}: every attempt was excluded by agenteval.")
            return 0.0, {"Unmeasurable": "all attempts excluded by agenteval"}

        scores = [item["score"].value for item in usable if item["score"].value is not None]
        total = statistics.mean(scores) if scores else 0.0
        first = usable[0]
        first_score = first["score"]
        first_attempt = first["attempt"]
        correctness = statistics.mean(item["score"].breakdown.correctness_recoverability for item in usable)
        token_eff = statistics.mean(item["score"].breakdown.token_efficiency for item in usable)
        wall_eff = statistics.mean(item["score"].breakdown.wallclock for item in usable)

        # The written half. GEPA reads this to decide what to try next.  It is
        # generated from record-v2, so the feedback and saved artifacts describe
        # the same classified evidence.
        for item in measured:
            oa.log(f'Question: "{example.question}"')
            oa.log(explain(item["record"]))
        ref = self.reference.get(example.id)
        if ref:
            direction = "better" if correctness > ref.correctness else (
                "worse" if correctness < ref.correctness else "unchanged")
            oa.log(
                f"Agenteval correctness/recovery {correctness:.2f} vs "
                f"{ref.correctness:.2f} before the change ({direction})."
            )

        return total, {
            "Score": f"{total:.4f} (agenteval {correctness:.2f}, "
                     f"tokens {token_eff:.2f}, speed {wall_eff:.2f})",
            "Commands": len(first_attempt.calls),
            "ClassifiedFailures": len(first_score.charged),
            "RecordedNotCharged": len(first_score.recorded_not_charged),
            "EnvironmentFailures": len(first_score.environment) + (1 if first_score.attempt_environment else 0),
            "SelfRecoveryRate": first_score.recovery.self_recovery_rate,
            "UsedBulkDownload": first_attempt.unnecessary_download,
        }


def _measure_attempt(attempt, reference: Reading | None) -> dict:
    record = build_record(attempt)
    tokens = attempt.transcript.usage.total_tokens
    wall = attempt.transcript.usage.duration_ms
    token_eff = agenteval_score.efficiency(reference.tokens if reference else None, tokens)
    wall_eff = agenteval_score.efficiency(reference.duration_ms if reference else None, wall)
    scored = agenteval_score.score_record(
        asdict(record),
        completed=attempt.completed,
        token_efficiency=token_eff,
        wallclock=wall_eff,
    )
    return {"attempt": attempt, "record": record, "score": scored}
