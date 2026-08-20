"""Everything that must stay the same across the whole run.

If any of these changed mid-run, two measurements couldn't be compared, and the
whole search would be chasing its own tail. So they live in one place and
nothing else is allowed to override them.

The only thing imported from the package is `credits`, which imports nothing
back, so this stays free of cycles.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import credits

ROOT = Path(__file__).resolve().parent.parent
EXPERIMENTS = ROOT / "experiments"

# The questions we ask the AI. Owned by us, not by the tool we're changing —
# otherwise a proposed change could edit the exam it's being marked on.
# Lives directly under experiments/ alongside proposals.json; the supporting
# research it came from is in experiments/artifacts/.
QUESTIONS = EXPERIMENTS / "questions.yaml"

# Sits in front of the real tool on PATH so we see every command the AI runs.
SHIM = ROOT / "autoresearch" / "shim" / "botmap"

# We ask each question twice. That is *not* to average them — two tries can't
# support that. It's so one flaky network call doesn't throw a question away.
REPEATS = 2

# Which model answers the map questions. This is the thing under test, so it
# must not change during a run.
AGENT_MODEL = "sonnet"

# Which model reads the feedback and proposes changes. Reached through
# OpenRouter, so one key covers every provider we might want to try.
REFLECTION_LM = "openrouter/anthropic/claude-opus-5"

# The same job, done through the Claude Code subscription instead of an API
# key. Chosen with `--proposer subscription`; see proposer.py for the catch.
PROPOSER_MODEL = "opus"

# The credential that model needs. Named here so preflight can check for it
# before a run starts, rather than after hours of evaluations.
REFLECTION_KEY_VAR = "OPENROUTER_API_KEY"

# Keys live here rather than in your shell profile, so a checkout is
# self-contained. Git ignores it.
ENV_FILE = ROOT / ".env"

# Least we are willing to start a run with. Not a forecast of what the run
# costs -- it is a floor that rules out the case where the baseline runs for an
# hour and the first proposal then fails for want of a few dollars.
MIN_BALANCE_USD = 5.0

# How long we let one question run before giving up.
RUN_TIMEOUT_S = 900

# The two surfaces we can evolve. One lever per run, so that when the score
# moves we know which of the two moved it.
#
# A lever is a set of files, not a single file, because most real improvements
# don't live in cli.py. Of the highest-severity problems we know about: the
# `--where` grammar is in filters.py, place resolution is in geocoding.py, and
# the advertised `--class` values are in introspection.py. Limiting the tool
# lever to cli.py would put four of the five worst findings out of reach.
#
# GEPA changes one file per round (its module selector goes round-robin), so a
# wider surface doesn't mean sprawling diffs — each proposal still touches one
# file, and we can still say which one moved the score.
LEVERS: dict[str, tuple[str, ...]] = {
    # How the tool behaves.
    "tool": (
        "botmap/cli.py",            # the commands, their flags, help and errors
        "botmap/filters.py",        # the --where grammar
        "botmap/geocoding.py",      # turning a place name into an area
        "botmap/introspection.py",  # the type/field/value lists the tool advertises
    ),
    # What the AI is told about the tool.
    "prompt": ("botmap/data/skill.md",),
}

# Deliberately NOT in the tool lever: botmap/core.py. It is the data-access
# plumbing, so a bad edit breaks every command at once, and its main known
# problem is latency — which our scoring only sees indirectly. Add it here if
# you want to go after that, but expect a rougher ride.

# The score. Correctness still dominates -- the first question is whether the
# AI can drive the tool at all. `struggle` is second and new: two candidates
# can both reach an answer while one of them made the assistant flail to get
# there, and the old score could not tell them apart. Speed and cost are
# demoted to tie-breakers, partly because `struggle` now captures some of the
# same waste more directly.
WEIGHTS = {
    "correctness": 0.45,
    "struggle": 0.35,
    "token_efficiency": 0.10,
    "wallclock": 0.10,
}

# How much each kind of struggle counts, within the struggle term.
#
# `silent` is heaviest on purpose. A command that exits 0 while saying "0 rows"
# is the worst failure in the system: the assistant reads it as "there are none
# here" and reports a confident wrong answer. Every other failure here is
# visible to the assistant and therefore recoverable; this one is not.
STRUGGLE_WEIGHTS = {
    "silent": 0.45,    # exited 0 but the answer was wrong and looked fine
    "waste": 0.25,     # failed commands before the first one that worked
    "path": 0.15,      # how many commands and turns it took at all
    "recovery": 0.15,  # did the error message hand back a usable next command
}

# How much work an assistant may do before we start calling it struggling.
# Below these it scores full marks -- the point is to punish flailing, not to
# demand a one-shot answer to a question that honestly needs three commands.
FREE_COMMANDS = 3
FREE_TURNS = 6

# Names the way the score is calculated. Recorded on every result so two runs
# scored by different rules are never compared as if they matched. Bumped from
# "proxy-v1" when the struggle term was added.
CORRECTNESS_IMPL = "struggle-v1"

# The older, narrower measure. Still computed and reported next to the new one,
# for one specific reason: the cached baselines on disk were measured under it,
# so it is the only number this run can honestly line up against the previous
# one. `score.correctness()` is deliberately left unchanged so this stays true.
LEGACY_CORRECTNESS_IMPL = "proxy-v1"

# The tool we're changing. `~/workspace/botmap` unless you say otherwise.
DEFAULT_REPO = Path.home() / "workspace" / "botmap"



def load_env() -> None:
    """Read `.env` into the environment, without clobbering what's already set.

    An already-exported variable wins, so you can override a single key for one
    run (`OPENROUTER_API_KEY=... python -m autoresearch.optimize`) without
    editing the file.

    Deliberately tiny rather than a dependency: we need `KEY=value` and nothing
    else. Lines that aren't that shape are skipped rather than raising, because
    a stray comment in a credentials file should not stop a run.
    """
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def repo_root() -> Path:
    """Where the tool under test lives."""
    return Path(os.environ.get("BOTMAP_REPO") or DEFAULT_REPO)


def requested_release() -> str | None:
    """The map-data snapshot we'd like every run to use, if one was asked for.

    Right now this is a wish, not a guarantee. botmap works out the latest
    snapshot by itself and ignores what we pass, so **runs are not pinned**.

    What that costs us: a run lasting several hours could straddle a new data
    release, and measurements either side of it would not be comparable. We're
    accepting that for now. The hook is left here so pinning starts working the
    day the tool supports it, with no other change.
    """
    return os.environ.get("BOTMAP_RELEASE")


# Everything importable in the tool, minus what should never be evolved. Used
# when you ask for a wider search than the curated default.
NEVER_EVOLVE = {
    "botmap/__init__.py",         # trivial re-exports
    "botmap/core.py",             # data plumbing: one bad edit breaks everything
    "botmap/skill_installer.py",  # installs the instructions; irrelevant at query time
}


def discoverable_files(repo: Path | None = None) -> tuple[str, ...]:
    """Every Python file in the tool that we'd be willing to evolve.

    Offered so the search space isn't limited to what we already know is
    broken. The trade-off is real: GEPA spreads its budget evenly across files,
    so doubling the file count halves the attempts each one gets.
    """
    root = (repo or repo_root()) / "botmap"
    found = sorted(f"botmap/{p.name}" for p in root.glob("*.py"))
    return tuple(f for f in found if f not in NEVER_EVOLVE)


def lever_files(lever: str, override: tuple[str, ...] | None = None) -> tuple[str, ...]:
    """The files a run is allowed to change, relative to the tool's repo.

    `override` lets the operator widen or narrow the search without editing
    this file — see `--files` and `--all-files` on the optimiser.
    """
    if lever not in LEVERS:
        raise ValueError(f"unknown lever {lever!r}; pick one of {sorted(LEVERS)}")
    if override:
        missing = [f for f in override if not (repo_root() / f).exists()]
        if missing:
            raise ValueError(f"these files do not exist in the tool: {missing}")
        return tuple(override)
    return LEVERS[lever]


def _check_funding(needs_api_key: bool) -> str:
    """Confirm the proposing model can actually be paid for.

    Split out because there are two ways to pay -- an API key with a balance,
    or the Claude Code subscription -- and only the first can be checked.
    """
    if not needs_api_key:
        # A subscription has rate limits rather than a balance, and there is
        # no way to ask "how much is left" before spending it.
        return "using the Claude Code subscription, not an API key"

    key = os.environ.get(REFLECTION_KEY_VAR)
    if not key:
        raise ValueError(
            f"{REFLECTION_KEY_VAR} is not set. The model that proposes changes "
            f"({REFLECTION_LM}) cannot run without it. Put it in {ENV_FILE}, "
            f"export it, or pass --proposer subscription."
        )

    # A key that is merely present tells us nothing: it may be revoked, or the
    # account may be empty. Both would only surface an hour in, after we had
    # paid for the baseline. One free request settles it.
    try:
        return credits.assess(credits.fetch(key), MIN_BALANCE_USD)
    except credits.Unreachable as exc:
        # Could not ask. That is not evidence against the key, and refusing to
        # start over a flaky network would be worse than trying.
        return f"could not check the balance ({exc}); continuing"


def preflight(needs_api_key: bool = True) -> dict[str, str]:
    """Check everything exists before we spend money.

    A run takes hours. Finding a bad path in hour three costs the whole run, so
    we look for every required piece up front.
    """
    load_env()
    balance_note = _check_funding(needs_api_key)

    repo = repo_root()
    required = [
        (repo / "botmap", f"{repo} doesn't look like a botmap checkout. Set BOTMAP_REPO."),
        *[(repo / f, f"{f} is missing; it is part of a lever we evolve")
          for files in LEVERS.values() for f in files],
        (SHIM, f"the command logger is missing at {SHIM}; without it we see nothing"),
        (QUESTIONS, f"no question bank at {QUESTIONS}"),
    ]
    for path, problem in required:
        if not path.exists():
            raise FileNotFoundError(problem)
    return {"repo": str(repo), "questions": str(QUESTIONS), "balance": balance_note}
