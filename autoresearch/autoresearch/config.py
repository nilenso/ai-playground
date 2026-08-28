"""Everything that must stay the same across the whole run.

If any of these changed mid-run, two measurements couldn't be compared, and the
whole search would be chasing its own tail. So they live in one place and
nothing else is allowed to override them.

The only thing imported from the package is `credits`, which imports nothing
back, so this stays free of cycles.
"""

from __future__ import annotations

import os
import statistics
import subprocess
import time
from pathlib import Path

FULL_REPO_CONTEXT_MAX_CHARS = 700_000
FULL_REPO_CONTEXT_FILE_MAX_CHARS = 40_000
EVALUATOR_FILE_PREFIXES = ("evals/", "tests/eval_fixtures/", "tests/test_eval_")

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

# The score. Correctness dominates because the question is whether the AI can
# drive the tool at all; speed and cost are tie-breakers, not the point.
WEIGHTS = {"correctness": 0.60, "token_efficiency": 0.20, "wallclock": 0.20}

# Names the way correctness is currently measured. Recorded on every result so
# two runs scored by different rules are never compared as if they matched.
CORRECTNESS_IMPL = "agenteval-v2"

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


# How long we give the tool to say which snapshot it is on. One S3 listing, so
# a slow answer means the network is unwell, not that the answer is far away.
RELEASE_PROBE_TIMEOUT_S = 60

# A few identical cheap reads, to find out whether the link is worth trusting
# before we spend an hour on a yardstick.
#
# This matters more than it looks. A `botmap` call that fails because the
# network dropped is recorded by the taxonomy as `traceback` -- the same label
# a real bug in the tool gets. So a flaky link does not merely add noise, it
# invents failure clusters that do not exist in the tool, and GEPA will
# dutifully try to fix them. Worse, a partial outage is harder to spot than a
# total one: everything still produces plausible numbers, and candidates get
# ranked by which minute they happened to run in.
NETWORK_PROBE_CALLS = 6
# Short on purpose. A call that takes longer than this is already useless to
# us, so waiting for it to finish buys nothing -- we count it as a failure and
# move on, which is also what stops the probe itself taking four minutes.
NETWORK_PROBE_TIMEOUT_S = 45
MAX_FAILURE_RATE = 0.25
# An agent chains several calls inside one question, and RUN_TIMEOUT_S caps a
# question at 900s. At a 120s median, roughly eight calls exhaust it -- so
# questions start timing out for reasons that have nothing to do with the
# candidate being measured.
MAX_MEDIAN_LATENCY_S = 120.0


def detected_release(repo: Path | None = None) -> str | None:
    """Which map-data snapshot the tool resolves to *right now*.

    Asked of the tool rather than worked out here, so our idea of the release
    and the tool's can never drift apart. It comes from `core.py`, which is in
    NEVER_EVOLVE, so no candidate can move this answer under us.

    None means we could not ask -- the tool has no interpreter, or the network
    was down. That is deliberately not fatal, for the same reason a
    credit-check failure isn't: refusing to start because S3 was slow would be
    worse than starting.
    """
    root = repo or repo_root()
    python = root / ".venv" / "bin" / "python"
    if not python.exists():
        return None
    try:
        done = subprocess.run(
            [str(python), "-c",
             "from botmap import core; print(core.get_latest_release())"],
            cwd=root, capture_output=True, text=True,
            timeout=RELEASE_PROBE_TIMEOUT_S,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    return done.stdout.strip() or None


def release_mismatch(baseline_release: str | None, current: str | None) -> str | None:
    """Why the cached yardstick can't be trusted, or None if it can.

    `botmap` is unpinned: it always uses the newest map-data release. So a
    baseline measured last week and a candidate measured today can sit on
    different data without anything looking wrong. Cost, speed and whether a
    place even resolves all move with the release, so the comparison silently
    stops meaning anything.

    Pure, so it can be tested without a network or a checkout. Either release
    being unknown means we cannot judge, which is not the same as a match.
    """
    if baseline_release is None or current is None:
        return None
    if baseline_release == current:
        return None
    return (
        f"the cached baseline was measured on map-data release "
        f"{baseline_release}, but the tool now resolves to {current}. "
        f"Candidates would be scored against a yardstick taken on different "
        f"data, so the numbers would not mean anything."
    )


# The fallback billing path, for when the subscription's quota runs out.
#
# Same model, different till. NOT a different model and NOT a different
# harness: measuring with another agent would answer "is botmap easy for that
# agent to drive", which is not the question this experiment asks.
#
# Claude Code appends `/v1/messages`, so the base stops at `/api`.
OPENROUTER_BASE = "https://openrouter.ai/api"
# `AGENT_MODEL` is the subscription's alias for the same thing; `--model
# sonnet` resolves to claude-sonnet-5, which is what this must name explicitly.
# Getting this wrong measures a model difference and calls it a path difference.
OPENROUTER_MODEL = "anthropic/claude-sonnet-5"


def agent_path() -> str:
    """Which till the agent was billed to: 'subscription' or 'openrouter'.

    Recorded on every measurement for exactly the reason `release` is. A
    yardstick taken on one path and candidates on another are not comparable,
    and nothing about the numbers would say so.
    """
    return os.environ.get("AUTORESEARCH_AGENT_PATH", "subscription")


def agent_provider() -> str:
    """Which host actually served the model.

    Worth recording separately from the path because OpenRouter spreads
    requests across whoever is serving a model unless pinned -- observed
    returning four different hosts in four calls. See orproxy.py.
    """
    return os.environ.get("AUTORESEARCH_AGENT_PROVIDER", "anthropic-subscription")


# One throwaway question, to find out whether the subscription has anything
# left before we ask it thirty more.
#
# This is the failure that reads *least* like a failure. The agent returns
# `is_error: true` with subtype "success" and the text "You've hit your session
# limit", which the harness turns into an attempt that did not complete. At
# baseline that costs us a skipped question. Inside a GEPA run there is no
# skip: it scores as correctness 0, meaning "this candidate broke the tool",
# and the budget goes on fixing something that was never wrong.
QUOTA_PROBE_TIMEOUT_S = 120

# Matched against the agent's own words. Kept as fragments rather than the
# whole sentence because the wording carries a reset time that varies.
_QUOTA_MARKERS = ("session limit", "usage limit", "rate limit", "quota")


def quota_problem(answer: str, is_error: bool) -> str | None:
    """Whether the subscription is spent, or None if it has something left.

    Pure, so the matching can be tested without spending anything.

    Only an *errored* reply counts. An agent that answers a question by
    talking about rate limits has told us nothing about our own quota, and
    treating that as exhaustion would refuse runs at random.
    """
    if not is_error:
        return None
    low = (answer or "").lower()
    if not any(marker in low for marker in _QUOTA_MARKERS):
        return None
    return (f"the agent's subscription is out of quota, so every question "
            f"would fail identically: {answer.strip()[:160]}")


def probe_quota(model: str | None = None) -> tuple[str, bool]:
    """Ask the agent one trivial question. Returns (answer, errored).

    Deliberately not a map question -- we are testing the account, not the
    tool, and it should cost as close to nothing as a call can.
    """
    import json as _json

    cmd = ["claude", "-p", "Reply with the single word: ok",
           "--output-format", "stream-json", "--verbose",
           "--model", model or AGENT_MODEL]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=QUOTA_PROBE_TIMEOUT_S)
    except (subprocess.SubprocessError, OSError):
        return "", False  # could not ask; the caller reports that as unchecked

    result = None
    for line in done.stdout.splitlines():
        try:
            event = _json.loads(line)
        except _json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            result = event
    if result is None:
        return "", False
    return str(result.get("result") or ""), bool(result.get("is_error"))


def _check_quota() -> str:
    """Refuse to start a run the subscription cannot pay for."""
    answer, errored = probe_quota()
    if not answer:
        return "could not ask the agent whether it has quota left; continuing"

    problem = quota_problem(answer, errored)
    if problem:
        raise ValueError(f"{problem}\n  Wait for the quota to reset and start again.")
    if errored:
        return f"the agent errored on a trivial question: {answer.strip()[:120]}"
    return "agent answered a trivial question, so there is quota left"


def probe_network(repo: Path | None = None, calls: int = NETWORK_PROBE_CALLS,
                  timeout: float = NETWORK_PROBE_TIMEOUT_S) -> tuple[list[float], int]:
    """Make a few identical cheap reads. Returns (latencies, failures).

    The same call every time, so any spread in the answers is the link and not
    the question. A timeout counts as a failure rather than something to wait
    out: we already know a call that slow is no use to us.

    Run against your checkout, which is unmodified, so a candidate cannot make
    the tool look like a bad network.
    """
    root = repo or repo_root()
    python = root / ".venv" / "bin" / "python"
    if not python.exists():
        return [], 0  # nothing attempted; the verdict treats that as "cannot say"

    # A real S3 data read over a small area -- the operation that was failing,
    # rather than a metadata listing that might succeed while reads do not.
    argv = [str(python), "-m", "botmap", "--json", "count", "-t", "place",
            "--bbox", "-73.967,40.699,-73.933,40.726"]

    latencies: list[float] = []
    failures = 0
    for _ in range(calls):
        started = time.monotonic()
        try:
            done = subprocess.run(argv, cwd=root, capture_output=True,
                                  text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            failures += 1
            continue
        except OSError:
            return latencies, failures  # cannot run it at all; stop asking
        if done.returncode == 0:
            latencies.append(time.monotonic() - started)
        else:
            failures += 1
    return latencies, failures


def network_problem(latencies: list[float], failures: int) -> str | None:
    """Why measuring now would be wasted, or None if the link looks sound.

    Pure, so the thresholds can be tested without a network.

    Nothing attempted means we cannot say, which is not the same as healthy --
    the caller reports that as unchecked rather than as a pass.
    """
    attempted = len(latencies) + failures
    if attempted == 0:
        return None

    rate = failures / attempted
    if rate > MAX_FAILURE_RATE:
        return (f"{failures} of {attempted} test calls to the map data failed "
                f"({rate:.0%}). Failed calls are recorded as `traceback`, the "
                f"same label a real bug gets, so the network would show up as "
                f"the tool's biggest failure cluster.")

    # No "everything failed" branch: with no successes the rate is 100%, so
    # the check above has already returned.
    median = statistics.median(latencies)
    if median > MAX_MEDIAN_LATENCY_S:
        return (f"the map data is answering slowly (median {median:.0f}s over "
                f"{len(latencies)} calls). An agent chains several calls per "
                f"question against a {RUN_TIMEOUT_S}s limit, so questions "
                f"would time out for reasons unrelated to the candidate.")
    return None


def _check_network() -> str:
    """Refuse to start measuring into a link that cannot be trusted."""
    latencies, failures = probe_network()
    attempted = len(latencies) + failures
    if attempted == 0:
        return "could not test the link to the map data; continuing"

    problem = network_problem(latencies, failures)
    if problem:
        raise ValueError(f"{problem}\n  Wait for the connection to settle and start again.")

    median = statistics.median(latencies)
    spread = max(latencies) / min(latencies)
    return (f"{len(latencies)}/{attempted} test calls ok, median {median:.0f}s, "
            f"spread {spread:.1f}x")


def _check_baseline_release(sha: str) -> str:
    """Refuse to reuse a yardstick measured on a different snapshot."""
    # Deferred: baseline imports config, so importing it at module scope would
    # be a cycle. Same pattern baseline._summarise uses for score.
    from . import baseline

    current = detected_release()
    if current is None:
        return ("could not ask the tool which map-data release it is on, so "
                "the baseline's snapshot went unchecked; continuing")

    saved = baseline.saved_release(sha)
    if saved is None:
        if baseline.path_for(sha).exists():
            return (f"the cached baseline predates release recording, so we "
                    f"cannot tell whether it matches {current}. Measure it "
                    f"again if the numbers look surprising.")
        return f"release {current}; no cached baseline yet"

    problem = release_mismatch(saved, current)
    if problem:
        path = baseline.path_for(sha)
        raise ValueError(
            f"{problem}\n"
            f"  Move it aside -- keep it, it is still the right reference for "
            f"runs made on {saved} -- and let a fresh one be measured:\n"
            f"    mv {path} {path.with_name(path.stem + '.' + saved + '.STALE.json')}"
        )
    return f"release {current}, matching the cached baseline"


# Everything importable in the tool, minus what should never be evolved in the
# curated "wider than default" mode. Explicit full-repo mode bypasses this list.
NEVER_EVOLVE = {
    "botmap/__init__.py",         # trivial re-exports
    "botmap/core.py",             # data plumbing: one bad edit breaks everything
    "botmap/skill_installer.py",  # installs the instructions; irrelevant at query time
}


def _tracked_files(repo: Path) -> tuple[str, ...]:
    done = subprocess.run(
        ["git", "ls-files"], cwd=repo, check=True, capture_output=True, text=True
    )
    return tuple(line for line in done.stdout.splitlines() if line)


def _read_utf8_text(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def discoverable_files(repo: Path | None = None) -> tuple[str, ...]:
    """Every Python module in the tool that curated wide mode may evolve."""
    root = (repo or repo_root()) / "botmap"
    found = sorted(f"botmap/{p.name}" for p in root.glob("*.py"))
    return tuple(f for f in found if f not in NEVER_EVOLVE)


def full_repo_files(repo: Path | None = None,
                    include_evaluator: bool = False) -> tuple[str, ...]:
    """Every tracked UTF-8 text file in botmap, for explicit full-edit runs.

    The evaluator/yardstick stays read-only by default.  Letting the optimiser
    edit it would reward changing the exam rather than making the CLI easier for
    agents.
    """
    root = repo or repo_root()
    return tuple(
        rel for rel in _tracked_files(root)
        if (root / rel).is_file()
        and _read_utf8_text(root / rel) is not None
        and (include_evaluator or not rel.startswith(EVALUATOR_FILE_PREFIXES))
    )


def full_repo_context(repo: Path | None = None,
                      max_chars: int = FULL_REPO_CONTEXT_MAX_CHARS,
                      file_max_chars: int = FULL_REPO_CONTEXT_FILE_MAX_CHARS) -> str:
    """A bounded read-only snapshot of the tracked botmap repo for GEPA."""
    root = repo or repo_root()
    parts = ["Tracked repo context follows. Paths are relative to the botmap repo."]
    used = len(parts[0])
    omitted = 0
    for rel in full_repo_files(root):
        text = _read_utf8_text(root / rel)
        if text is None:
            continue
        if len(text) > file_max_chars:
            text = text[:file_max_chars] + "\n... [file truncated in context]\n"
        block = f"\n\n--- FILE: {rel} ---\n{text}"
        if used + len(block) > max_chars:
            omitted += 1
            continue
        parts.append(block)
        used += len(block)
    if omitted:
        parts.append(f"\n\n... [{omitted} tracked text files omitted from context budget]")
    return "".join(parts)


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


def preflight(needs_api_key: bool = True, sha: str | None = None,
              check_network: bool = True, check_quota: bool = True) -> dict[str, str]:
    """Check everything exists before we spend money.

    A run takes hours. Finding a bad path in hour three costs the whole run, so
    we look for every required piece up front.

    Pass `sha` to also check that the cached baseline was measured on the same
    map-data release the tool is on now. Without it that check is skipped,
    because there is no baseline to check against.
    """
    load_env()
    balance_note = _check_funding(needs_api_key)
    release_note = _check_baseline_release(sha) if sha else "not checked"
    # Last two, because they are the slowest and there is no point testing the
    # link or the quota if we already know the key or the yardstick is wrong.
    network_note = _check_network() if check_network else "not checked"
    quota_note = _check_quota() if check_quota else "not checked"

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
    return {"repo": str(repo), "questions": str(QUESTIONS),
            "balance": balance_note, "release": release_note,
            "network": network_note, "quota": quota_note}
