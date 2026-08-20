"""How much does the score move when nothing changed?

Two runs of the *unchanged* tool should score identically. They do not: the
assistant is not deterministic, so the same question asked twice takes a
different path. That spread is the noise floor, and it is the number that
decides whether a candidate's gain is real or a lucky draw.

We need this more than the previous scoring did. `correctness` has a track
record -- we have watched it across several runs and have a feel for what a
meaningful move looks like. The `struggle` terms are new, carry 0.35 of the
weight between them, and have no track record at all. Believing a movement in
them without knowing their wobble would be guessing with extra steps.

What this measures, and what it does not. Two runs give **run-to-run variance
on the same question**, which is what a noise floor is. It is not the spread of
struggle *across* questions -- questions differ from each other for real
reasons, and that number would look like noise while being signal.

    python -m autoresearch.noise_floor RUN1/attempts RUN2/attempts

Read-only. It never writes into a run directory.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path

from . import config, questions as qmod, score
from .questions import Question
from .score import Attempt
from .trace import parse_calls, parse_transcript

# The order they are reported in: headline terms first, then the breakdown of
# the one being put on trial.
TERMS = ("correctness", "struggle")
SUB_TERMS = tuple(config.STRUGGLE_WEIGHTS)


# Claude names the skill it loaded in its own context, which is the only
# record of *which* instruction file the agent actually read.
_SKILL_SOURCE = re.compile(r"Base directory for this skill: ([^\"\\]+)")

# A user-global skill lives directly in someone's home: /Users/<name>/.claude
# or /home/<name>/.claude. Matched by shape rather than against this machine's
# actual home, so the check does not quietly stop working somewhere else.
#
# Requiring `.claude` to sit immediately under the user directory is what keeps
# a project that happens to live under home -- ~/work/thing/.claude/skills --
# from being misread as the global one.
_USER_SKILL_ROOT = re.compile(r"^/(?:Users|home)/[^/]+/\.claude/")


def skill_source(transcript: Path) -> str | None:
    """Which copy of the botmap instructions this attempt actually loaded.

    Worth extracting because it is invisible everywhere else and has already
    bitten us once: a user-global skill of the same name shadowed the
    project-scoped copy the runner installs, so edits to the instructions were
    written to a file no agent ever read. Nothing in the score would have shown
    that -- the run would simply have found nothing.
    """
    if not transcript.exists():
        return None
    found = _SKILL_SOURCE.search(transcript.read_text(encoding="utf-8", errors="replace"))
    return found.group(1) if found else None


def _skill_sources(attempts_dir: Path, bank: list[Question]) -> Counter:
    seen: Counter = Counter()
    for q in bank:
        for d in sorted(attempts_dir.glob(f"{q.id}__r*")):
            source = skill_source(d / "transcript.jsonl")
            if source:
                # Both paths end in `.claude/skills/botmap` -- the project copy
                # lives at <workdir>/.claude/skills/botmap -- so the tail tells
                # them apart not at all. What distinguishes them is the root:
                # the shadowing copy sits under the user's home, the real one
                # under the run's temp workdir.
                seen["user-global" if _USER_SKILL_ROOT.match(source)
                     else "project-scoped"] += 1
    return seen


def load_attempts(attempts_dir: Path, question: Question) -> list[Attempt]:
    """Rebuild one question's attempts from the files a run left behind.

    Deliberately re-derived with the current scorer rather than read from any
    recorded number: the point is to find out how *this* code behaves, and a
    figure saved by an earlier version would answer a different question.
    """
    found = []
    for d in sorted(attempts_dir.glob(f"{question.id}__r*")):
        repeat = d.name.rsplit("__r", 1)[-1]
        found.append(
            score.analyse(
                question,
                parse_calls(d / "commands.jsonl"),
                parse_transcript(d / "transcript.jsonl"),
                int(repeat) if repeat.isdigit() else 0,
            )
        )
    return found


def _scored(attempts: list[Attempt]) -> dict[str, float] | None:
    """One question's numbers, filtered exactly as the evaluator filters them.

    Mirrors `Evaluator.__call__` on purpose. A noise floor measured over
    attempts the real run would have discarded would not describe the real run.
    """
    usable = [a for a in attempts if a.ok and not a.network_bound]
    if not usable:
        return None

    terms = [score.struggle_terms(a) for a in usable]
    row = {
        "correctness": score.correctness(usable),
        "struggle": score.struggle(usable),
        "tokens": statistics.mean(a.transcript.usage.total_tokens for a in usable),
        "duration_ms": statistics.mean(a.transcript.usage.duration_ms for a in usable),
    }
    for name in SUB_TERMS:
        row[name] = statistics.mean(t[name] for t in terms)
    return row


def compare(dir_a: Path, dir_b: Path,
            bank: list[Question] | None = None) -> dict[str, object]:
    """Pair up the two runs question by question and measure the wobble."""
    bank = bank if bank is not None else qmod.load()

    paired: dict[str, dict[str, float]] = {}
    dropped: dict[str, str] = {}
    for q in bank:
        a = _scored(load_attempts(dir_a, q))
        b = _scored(load_attempts(dir_b, q))
        if a is None or b is None:
            # Named rather than skipped silently. A noise floor computed over
            # whichever questions happened to survive is not a noise floor.
            missing = "run 1" if a is None else ("run 2" if b is None else "both")
            dropped[q.id] = f"no usable attempts in {missing}"
            continue
        paired[q.id] = {name: abs(a[name] - b[name])
                        for name in (*TERMS, *SUB_TERMS)}
        # Cost and speed are scored as a ratio against the baseline, so their
        # wobble is how far that ratio strays from "identical" -- which is 0.5,
        # not 0. See score.efficiency.
        paired[q.id]["token_efficiency"] = abs(
            score.efficiency(a["tokens"], b["tokens"]) - 0.5)
        paired[q.id]["wallclock"] = abs(
            score.efficiency(a["duration_ms"], b["duration_ms"]) - 0.5)

    sources = {"run_a": _skill_sources(dir_a, bank), "run_b": _skill_sources(dir_b, bank)}
    return {"paired": paired, "dropped": dropped,
            "summary": _summarise(paired), "objective": _objective_floor(paired),
            "skill_sources": {k: dict(v) for k, v in sources.items()},
            "skills_consistent": all(len(v) <= 1 for v in sources.values())
                                 and set(sources["run_a"]) == set(sources["run_b"])}


def _spread(values: list[float]) -> dict[str, float]:
    if not values:
        return {"median": 0.0, "mean": 0.0, "p90": 0.0, "max": 0.0}
    ordered = sorted(values)
    # Index rather than statistics.quantiles: with 30 points the interpolated
    # answer implies a precision we do not have, and the honest p90 is simply
    # "the value 90% of questions came in under".
    p90 = ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]
    return {"median": statistics.median(ordered), "mean": statistics.fmean(ordered),
            "p90": p90, "max": ordered[-1]}


def _summarise(paired: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    names = (*TERMS, "token_efficiency", "wallclock", *SUB_TERMS)
    return {n: _spread([row[n] for row in paired.values() if n in row]) for n in names}


def _objective_floor(paired: dict[str, dict[str, float]]) -> dict[str, float]:
    """How far the overall score can drift on its own, per question.

    Weighted sum of each term's wobble. This is a deliberate over-estimate: it
    adds the movements as if they all fell the same way, when in practice they
    partly cancel. For a "must beat this to be believed" threshold, erring
    high is the safe direction -- the cost of a threshold set too low is
    believing a fluke and shipping it.
    """
    w = config.WEIGHTS
    per_question = [
        sum(w[name] * row[name] for name in w if name in row)
        for row in paired.values()
    ]
    return _spread(per_question)


def render(result: dict[str, object]) -> str:
    paired, summary = result["paired"], result["summary"]
    obj = result["objective"]
    out = [
        "STRUGGLE NOISE FLOOR",
        f"{len(paired)} question(s) measured twice on the unchanged tool.",
        "",
        "Run-to-run wobble, |run 1 - run 2| on the same question:",
        "",
        f"  {'term':<20} {'median':>8} {'mean':>8} {'p90':>8} {'max':>8}  weight",
    ]
    for name in (*TERMS, "token_efficiency", "wallclock"):
        s = summary[name]
        weight = config.WEIGHTS.get(name)
        out.append(f"  {name:<20} {s['median']:>8.3f} {s['mean']:>8.3f} "
                   f"{s['p90']:>8.3f} {s['max']:>8.3f}  "
                   f"{weight if weight is None else format(weight, '.2f')}")

    out += ["", "  struggle, broken down (unweighted, within-term weights shown):"]
    for name in SUB_TERMS:
        s = summary[name]
        out.append(f"    {name:<18} {s['median']:>8.3f} {s['mean']:>8.3f} "
                   f"{s['p90']:>8.3f} {s['max']:>8.3f}  "
                   f"{config.STRUGGLE_WEIGHTS[name]:.2f}")

    out += [
        "",
        f"MINIMUM BELIEVABLE MOVEMENT: {obj['p90']:.3f}",
        "",
        "  A candidate must beat the baseline by more than this before the gain",
        "  is worth believing. Nine questions in ten drift by less than it with",
        "  nothing changed at all. It is an over-estimate on purpose: it adds",
        "  every term's wobble as if they all fell the same way.",
        f"  (median drift {obj['median']:.3f}, worst question {obj['max']:.3f})",
    ]

    if not result["skills_consistent"]:
        # Loud, because it inflates the very number this script exists to
        # produce: a condition that changed between or within runs shows up as
        # run-to-run wobble and is indistinguishable from the assistant's own
        # variability.
        out += ["", "WARNING: the two runs did not read the same instruction file.",
                f"  run 1: {result['skill_sources']['run_a'] or 'unknown'}",
                f"  run 2: {result['skill_sources']['run_b'] or 'unknown'}",
                "  Any difference between those files is being counted as noise,",
                "  so the floor above is an over-estimate of the assistant's own",
                "  wobble. If the files were byte-identical this is harmless; if",
                "  they were not, re-measure before trusting the number."]

    if result["dropped"]:
        out += ["", "NOT COUNTED (no usable attempts in one or both runs):"]
        out += [f"  {qid}: {why}" for qid, why in sorted(result["dropped"].items())]
        out.append("  A floor computed over only the questions that survived would")
        out.append("  not be a floor, so these are named rather than dropped quietly.")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_a", type=Path, help="first run's attempts/ directory")
    ap.add_argument("run_b", type=Path, help="second run's attempts/ directory")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    for d in (args.run_a, args.run_b):
        if not d.is_dir():
            raise SystemExit(f"not a directory: {d}\n"
                             f"Expected a run's attempts/ folder, the one holding "
                             f"<question-id>__r<n>/ subdirectories.")

    result = compare(args.run_a, args.run_b)
    if not result["paired"]:
        raise SystemExit("No question had usable attempts in both runs — nothing to compare.")
    print(json.dumps(result, indent=2) if args.json else render(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
