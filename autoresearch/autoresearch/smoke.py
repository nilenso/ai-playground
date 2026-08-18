"""Checks the machinery works before you spend money on a real run.

A real run takes hours and costs real money. Everything here is designed to
fail in the first minute instead, and each check covers a seam that could
otherwise break silently.

    python -m autoresearch.smoke            # free, about a minute
    python -m autoresearch.smoke --ask      # plus one real question (~$0.50)
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from . import baseline, config, questions as qmod, runner, score
from .worktree import Pool, head_sha

_failures = 0


def ok(label: str, detail: str = "") -> None:
    print(f"  PASS  {label}{f' — {detail}' if detail else ''}")


def bad(label: str, detail: str) -> None:
    global _failures
    _failures += 1
    print(f"  FAIL  {label} — {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ask", action="store_true", help="also ask one real question")
    args = ap.parse_args()

    print("autoresearch smoke check\n")

    print("[1] Settings and inputs")
    try:
        checks = config.preflight()
        ok("everything we need is where we expect it", checks["repo"])
        # Never print the key itself — only that one was found, and where from.
        ok("the proposer has a key", f"{config.REFLECTION_KEY_VAR} for {config.REFLECTION_LM}")
    except (FileNotFoundError, ValueError) as exc:
        bad("settings", str(exc))
        return _report()

    bank = qmod.load()
    train, val = qmod.split(bank)
    ok("question bank loads", f"{len(bank)} questions")
    ok("split holds questions back", f"{len(train)} to learn from, {len(val)} to check")
    if {q.tier for q in val} != {q.tier for q in train}:
        bad("split covers every difficulty", "one half is missing a tier")
    else:
        ok("both halves cover every difficulty")

    # Deliberately a note, not a failure. We decided not to pin the map data
    # for now: botmap is meant to use the latest snapshot, and forcing it would
    # mean changing the tool we're measuring. The cost is that a run lasting
    # hours could straddle a new data release, and results either side of it
    # wouldn't be comparable.
    print("  note  map data is not pinned — the tool uses whatever is latest.")
    print("        A long run could straddle a data release. Worth revisiting.")

    print("\n[2] Private copy of the tool")
    sha = head_sha()
    pool = Pool(sha)
    pool.prune()
    try:
        tree = pool.acquire()
        ok("made a private copy", f"{sha} at {tree}")

        # If a proposed change didn't actually reach the copy, every candidate
        # would score the same and the whole run would be meaningless. We check
        # every file in the lever, not just the first — most real improvements
        # land somewhere other than cli.py.
        marker = "# smoke-marker\n"
        original = pool.read_original("tool")
        ok("lever covers several files", ", ".join(Path(f).name for f in original))

        pool.write_candidate(tree, "tool", {k: v + marker for k, v in original.items()})
        missed = [f for f in original if not (tree / f).read_text().endswith(marker)]
        if missed:
            bad("a change reaches every file in the lever", f"did not reach: {missed}")
        else:
            ok("a change reaches every file in the lever", f"{len(original)} file(s)")

        changed = sorted(subprocess.run(["git", "diff", "--name-only"], cwd=tree,
                                        capture_output=True, text=True).stdout.split())
        if changed == sorted(original):
            ok("nothing outside the lever is touched")
        else:
            unexpected = set(changed) - set(original)
            bad("nothing outside the lever is touched", f"also changed: {sorted(unexpected)}")

        # A candidate may change just one file. The rest must be left alone.
        pool.reset(tree)
        one = config.lever_files("tool")[1]  # deliberately not cli.py
        pool.write_candidate(tree, "tool", {one: original[one] + marker})
        changed = subprocess.run(["git", "diff", "--name-only"], cwd=tree,
                                 capture_output=True, text=True).stdout.split()
        if changed == [one]:
            ok("a one-file change touches only that file", one)
        else:
            bad("a one-file change touches only that file", f"changed: {changed}")

        pool.reset(tree)
        ok("the copy resets cleanly")

        print("\n[3] Command logger")
        log = Path("/tmp/autoresearch-smoke.log")
        log.unlink(missing_ok=True)
        env_python = runner.venv_python(tree)
        proc = subprocess.run([str(config.SHIM), "--json", "themes"],
                              capture_output=True, text=True,
                              env={"PATH": "/usr/bin:/bin",
                                   "AUTORESEARCH_LOG": str(log),
                                   "AUTORESEARCH_PYTHON": env_python},
                              cwd=tree)
        from .trace import parse_calls
        calls = parse_calls(log)
        if len(calls) == 1 and calls[0].exit_code == 0:
            ok("every command is written down", " ".join(calls[0].argv))
        else:
            bad("every command is written down", f"expected 1 clean call, saw {len(calls)}")
        # A logger that changed what the AI sees would change the behaviour
        # we're trying to measure, so this is the important half.
        if calls and proc.stdout.strip() == calls[0].stdout.strip():
            ok("the AI sees the tool's real output, unchanged")
        else:
            bad("the AI sees the tool's real output, unchanged", "output differed")
        log.unlink(missing_ok=True)

        print("\n[4] Yardstick")
        ref = baseline.load(sha)
        if ref:
            ok("we already measured the unchanged tool", f"{len(ref)} questions")
        else:
            print(f"  note  no yardstick for {sha} yet; the first real run measures it once")

        if args.ask:
            print("\n[5] One real question")
            q = train[0]
            print(f"  asking: {q.question!r}  (~$0.50, up to 15 min)")
            attempts = runner.ask_repeatedly(q, tree, repeats=1)
            a = attempts[0]
            if not a.ok:
                bad("the question ran", "it crashed or timed out")
            else:
                ok("the question ran", f"{len(a.calls)} commands, answered={a.completed}")
                ok("cost recorded",
                   f"{a.transcript.usage.total_tokens} tokens, "
                   f"${a.transcript.usage.cost_usd:.2f}, "
                   f"{a.transcript.usage.duration_ms // 1000}s")
                if a.transcript.usage.total_tokens == 0:
                    bad("cost recorded", "zero tokens — the transcript format may have changed")
                if not a.calls:
                    bad("the logger caught the AI's commands",
                        "no commands logged; PATH may not be picking up the logger")
                print("\n  --- what GEPA would be told ---")
                for line in score.feedback(q, attempts).splitlines()[:14]:
                    print(f"  {line}")
        else:
            print("\n[5] One real question — skipped (pass --ask to spend ~$0.50)")
    finally:
        pool.close()

    return _report()


def _report() -> int:
    print()
    if _failures:
        print(f"{_failures} check(s) failed — fix before a real run.")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
