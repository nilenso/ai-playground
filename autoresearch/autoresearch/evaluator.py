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
from pathlib import Path

import gepa.optimize_anything as oa

from . import config, runner, score
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
        # An attempt that never got a command through to the data tells us
        # nothing about this candidate, so it is dropped rather than averaged
        # in. Averaging it would quietly move the score by however bad the
        # connection was that minute.
        usable = [a for a in attempts if a.ok and not a.network_bound]

        # Every try crashed or timed out. That's a broken measurement, not a
        # bad candidate, so say so rather than blaming the candidate.
        if not usable:
            why = ("every attempt failed reaching the map data, so the tool was "
                   "never really tested" if any(a.network_bound for a in attempts)
                   else "every attempt crashed or timed out")
            oa.log(f"Could not measure {example.id}: {why}.")
            return 0.0, {"Unmeasurable": why}

        # Deliberately still the old, narrower measure. Keeping it unchanged is
        # what lets the comparison against the cached baseline below stay
        # honest: that baseline was recorded under these rules, and a number
        # computed under new rules could not be held up against it.
        correct = score.correctness(usable)
        struggled = score.struggle(usable)
        tokens = statistics.mean(a.transcript.usage.total_tokens for a in usable)
        wall = statistics.mean(a.transcript.usage.duration_ms for a in usable)

        ref = self.reference.get(example.id)
        token_eff = score.efficiency(ref.tokens if ref else None, tokens)
        wall_eff = score.efficiency(ref.duration_ms if ref else None, wall)
        total = score.objective(correct, struggled, token_eff, wall_eff)

        # The written half. GEPA reads this to decide what to try next.
        oa.log(score.feedback(example, attempts))
        if ref:
            direction = "better" if correct > ref.correctness else (
                "worse" if correct < ref.correctness else "unchanged")
            oa.log(
                f"Correctness {correct:.2f} vs {ref.correctness:.2f} before "
                f"the change ({direction})."
            )

        return total, {
            "Score": f"{total:.4f} (correctness {correct:.2f}, "
                     f"struggle {struggled:.2f}, tokens {token_eff:.2f}, "
                     f"speed {wall_eff:.2f})",
            "Commands": len(usable[0].calls),
            "Turns": usable[0].transcript.usage.num_turns,
            "WastedBeforeFirstSuccess": usable[0].wasted,
            "SilentWrongAnswers": usable[0].silent_failures,
            "NetworkFailures": usable[0].network_failures,
            "FailedCommands": len(usable[0].errors),
            "RecoveredFromError": usable[0].recovered,
            "UsedBulkDownload": usable[0].unnecessary_download,
        }
