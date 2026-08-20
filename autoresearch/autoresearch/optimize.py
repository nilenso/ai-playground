"""The loop. Point GEPA at one file in the tool and let it evolve.

How it works, in one paragraph: we hand GEPA the current contents of a file
(either the tool's code or its instructions), plus a way to score any proposed
replacement. GEPA rewrites the file, we measure how well an AI can drive the
result, and we hand back both a score and a plain-text account of what went
wrong. GEPA reads that account, works out what to change, and tries again.
The best version it finds is written out at the end.

Two rules keep the answer meaningful:

- **One file per run.** If we changed the code and the instructions at once and
  the score moved, we wouldn't know which one moved it. Run it twice instead,
  and compare.
- **Held-out questions.** GEPA optimises against one set of questions and is
  scored on a set it never saw. Without that we'd only learn that it can
  memorise the questions we gave it.

    python -m autoresearch.optimize --lever tool --budget 60
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import gepa.optimize_anything as oa

from . import (baseline, blocked, config, proposer as proposer_mod,
               questions as qmod, repo_context)
from .evaluator import Evaluator, QuotaExhausted
from .worktree import Pool, head_sha

# Told to the improver so it knows what it's working on and what "better"
# means here. Without this it would optimise the file as generic code.
BACKGROUND = """
You are improving a command-line tool called `botmap`, which answers questions
about map data (places, buildings, roads, addresses, administrative areas).

The people using it are AI assistants, not humans. An assistant is given a
plain-English question such as "how many hospitals are in Rhode Island?", has a
shell, and must work out the right `botmap` command on its own. Nobody tells it
which command to use. Working that out is exactly what is being measured.

So a good change is one that makes the right command easier for an assistant to
find, choose, and trust. Things that have helped before:

- adding a purpose-built command for a common task, so the assistant does not
  fall back to the bulk `download` escape hatch;
- error messages that name the problem AND give a ready-to-run replacement
  command, so a wrong first try becomes a correct second try;
- accepting the obvious spelling of an argument as well as the official one;
- making a command that already exists work for more of the cases an assistant
  will reasonably try it on.

Things that score badly:

- returning zero results without explanation. An assistant reads that as "there
  are none here" and confidently reports a wrong answer. This is the worst
  failure mode in the system.
- crashing with a raw Python traceback.
- being correct but so hard to discover that the assistant never finds it.

Keep the file valid Python that still starts. A file that will not import
scores zero without being tested at all.

IMPORTANT — you can only EDIT the files listed below. You can SEE the rest of
the tool: its source is included further down, read-only. Those are different
permissions and it is worth keeping them apart in your head. Read anything;
change only what you are given.

If you work out that the real cause of a failure lives in a file you can read
but not edit, do NOT paper over it somewhere else, and do NOT copy that file's
logic into one you can edit. Say so plainly in your reasoning and name the
file, like "the actual fix belongs in core.py". We read your reasoning after
the run and will widen the next one. A clear statement that you are blocked is
more useful to us than a workaround that muddies the measurement.

If what you need is a file that does not exist yet, you cannot create it — the
set of files you can edit is fixed before you start. Ask for it instead, on its
own line, exactly like this:

    NEW FILE NEEDED: botmap/boundary.py - the polygon logic does not belong in cli.py

Write that line every time you hit the same wall. We count these after the run,
create the files, and hand them to you next time. Asking is always better than
cramming the code somewhere it does not belong to get the score up.
"""


def _objective_text(lever: str) -> str:
    if lever == "tool":
        return (
            "Rewrite this command-line tool so an AI assistant, given a plain-English "
            "question about maps and nothing else, reliably works out the right command "
            "on the first or second try."
        )
    return (
        "Rewrite these instructions so an AI assistant reading them reliably works out "
        "the right `botmap` command for a plain-English map question."
    )


def run(lever: str, budget: int, holdout: float, reflection_lm: str,
        workers: int, keep_runs: bool,
        files: tuple[str, ...] | None = None,
        proposer: str = "api",
        repo_context_chars: int = repo_context.DEFAULT_BUDGET_CHARS) -> None:
    started = time.time()
    subscription = proposer == "subscription"
    checks = config.preflight(needs_api_key=not subscription)
    sha = head_sha()
    print(f"[oa] tool: {checks['repo']} @ {sha}")
    print("[oa] map data: NOT pinned — the tool uses whatever is latest")
    # Either a model name for litellm to bill, or a callable that shells out
    # to `claude -p` on the subscription. GEPA accepts both.
    proposing_lm = proposer_mod.claude_cli() if subscription else reflection_lm
    described = (f"claude -p --model {config.PROPOSER_MODEL}" if subscription
                 else reflection_lm)
    print(f"[oa] proposals from: {described} ({checks['balance']})")
    files = config.lever_files(lever, files)
    print(f"[oa] lever '{lever}' covers {len(files)} file(s):")
    for f in files:
        print(f"[oa]   {f}")
    print("[oa] GEPA changes one of them per round, so each change stays attributable")

    # Read-only sight of everything else. Editing stays as narrow as it was --
    # only what it can *see* widens.
    repo = Path(checks["repo"])
    if repo_context_chars > 0:
        context = repo_context.build(repo, files, repo_context_chars)
        context_note = repo_context.describe(repo, files, repo_context_chars)
        print(f"[oa] plus read-only context on the whole repo "
              f"({context_note['chars']:,} chars, ~{context_note['chars'] // 4:,} "
              f"tokens per proposal)")
        for f in context_note["mapped_only"]:
            print(f"[oa]   {f}: listed but not included")
    else:
        context = ""
        context_note = {"chars": 0, "disabled": True}
        print("[oa] no repo context — GEPA sees only the files it may edit")
    per_file = budget // max(1, len(files))
    if per_file < 8:
        print(f"[oa] warning: ~{per_file} evaluations per file. GEPA spreads its "
              f"budget evenly, so a wide file list with a small budget finds little. "
              f"Raise --budget or narrow --files.")

    bank = qmod.load()
    train, val = qmod.split(bank, holdout)
    print(f"[oa] {len(train)} questions to learn from, {len(val)} held back to check")

    run_dir = config.ROOT / "experiments" / "runs" / f"{lever}-{sha}-{int(started)}"
    run_dir.mkdir(parents=True, exist_ok=True)
    keep_dir = run_dir / "attempts" if keep_runs else None

    pool = Pool(sha, files=files)
    pool.prune()
    try:
        tree = pool.acquire()

        # The yardstick: how the unchanged tool performs. Measured once per
        # commit and reused, because it is the same for every candidate and
        # it is the most expensive thing we do.
        reference = baseline.load(sha)
        if reference is None:
            print(f"[oa] no yardstick for {sha} yet — measuring the unchanged tool once")
            pool.reset(tree)
            reference = baseline.measure(bank, tree, sha, keep_dir=keep_dir)
        else:
            print(f"[oa] reusing the yardstick measured earlier for {sha}")

        evaluate = Evaluator(lever, pool, reference, keep_dir=keep_dir)
        seed = pool.read_original(lever)
        total = sum(len(t.splitlines()) for t in seed.values())
        print(f"[oa] starting from the current files ({total} lines in total)")
        print(f"[oa] budget: {budget} evaluations (each is ~{config.REPEATS} questions asked)")

        result = oa.optimize_anything(
            seed,
            evaluator=evaluate,
            dataset=train,
            valset=val,          # dataset + valset = "make it generalise"
            objective=_objective_text(lever),
            background=BACKGROUND + "\n\nFiles you may edit on this run:\n"
            + "\n".join(f"  - {f}" for f in files) + context,
            config=oa.GEPAConfig(
                engine=oa.EngineConfig(
                    max_metric_calls=budget,
                    run_dir=str(run_dir / "gepa"),
                    # Parallel workers each need their own copy of the tool,
                    # which the pool hands out per thread.
                    parallel=workers > 1,
                    max_workers=workers,
                    # Asking the same question of the same candidate twice
                    # would be pure waste at ~$0.50 a go.
                    cache_evaluation=True,
                    display_progress_bar=True,
                ),
                reflection=oa.ReflectionConfig(reflection_lm=proposing_lm),
            ),
        )

        best = result.best_candidate
        # GEPA returns text instead of a mapping only when it was seeded with
        # text. We always seed a mapping, so this should not happen -- and
        # guessing which file the text belonged to would be worse than
        # stopping, because we would attribute one file's content to another.
        if not isinstance(best, dict):
            raise TypeError(
                f"expected the best candidate as a mapping of file -> contents, "
                f"got {type(best).__name__}"
            )

        # Write each improved file out under its own name, so you can diff any
        # one of them against the original on its own.
        best_dir = run_dir / "best"
        for rel, text in best.items():
            out = best_dir / Path(rel).name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")

        # A patch is easier to review than whole rewritten files, and reviewing
        # it is the point — nothing here is applied automatically.
        #
        # Reset first: this copy last held whatever candidate GEPA evaluated
        # most recently, which is usually not the best one. Diffing without
        # clearing it risks a patch carrying edits that were never part of the
        # result we are reporting.
        pool.reset(tree)
        pool.write_candidate(tree, lever, best)
        import subprocess
        diff = subprocess.run(["git", "diff"], cwd=tree, capture_output=True, text=True).stdout
        (run_dir / "change.patch").write_text(diff)
        pool.reset(tree)

        wanted = blocked.scan(run_dir / "gepa", files, Path(checks["repo"]))
        note = blocked.report(wanted)
        if note and context_note.get("chars"):
            # The counts mean something different once GEPA can see the whole
            # repo. Before, naming a file it could not read was a deliberate
            # act; now it can mention core.py simply because core.py is in
            # front of it. The mentions are still worth reading -- but it is
            # the reason attached to one that carries the evidence, not how
            # many times the name appears.
            note = (
                "NOTE: this run gave GEPA read-only sight of the whole repo, so\n"
                "it could name any file whether or not it was blocked. Read\n"
                "the reasons rather than the counts: the counts are inflated\n"
                "by visibility and are not comparable with a run that had no\n"
                "repo context (--repo-context-chars 0).\n\n"
            ) + note
        if note:
            (run_dir / "blocked-files.txt").write_text(note)

        summary = {
            "lever": lever,
            "wanted_existing_files_out_of_scope": dict(wanted.out_of_scope),
            "wanted_files_that_do_not_exist": dict(wanted.new_files),
            "new_file_reasons": wanted.reasons,
            "files": list(files),
            "files_changed": sorted(
                rel for rel, text in best.items() if text != seed.get(rel)
            ),
            "sha": sha,
            "release_requested": config.requested_release(),
            "pinned": False,
            "correctness_impl": config.CORRECTNESS_IMPL,
            "legacy_correctness_impl": config.LEGACY_CORRECTNESS_IMPL,
            "weights": dict(config.WEIGHTS),
            "struggle_weights": dict(config.STRUGGLE_WEIGHTS),
            # Two runs given different views of the repo are not comparable,
            # and without this there would be no way to tell afterwards.
            "repo_context": context_note,
            "proposer": described,
            "budget": budget,
            "evaluations_run": evaluate.calls,
            "candidates_tried": getattr(result, "num_candidates", None),
            "train_questions": [q.id for q in train],
            "heldout_questions": [q.id for q in val],
            "minutes": round((time.time() - started) / 60, 1),
            "finished": datetime.now(timezone.utc).isoformat(),
        }
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))

        print(f"\n[oa] done in {summary['minutes']} min, {evaluate.calls} evaluations")
        print(f"[oa] best files   : {best_dir}")
        print(f"[oa] as a patch   : {run_dir / 'change.patch'}")
        print("[oa] nothing was applied to your checkout — review the patch first.")
        if note:
            print()
            print(note)
    except QuotaExhausted as exc:
        # Leave a note in the run directory rather than only on the terminal.
        # A half-finished run that cannot say why it stopped is indistinguishable
        # from one that found nothing, and we have already lost a day to a
        # directory full of numbers nobody could account for.
        (run_dir / "ABORTED-QUOTA.md").write_text(
            "# Run aborted — subscription quota exhausted\n\n"
            f"Lever `{lever}` at `{sha}`, stopped after {evaluate.calls} "
            f"evaluation(s).\n\n"
            f"{exc}\n\n"
            "## These numbers are not results\n\n"
            "Nothing here says anything about the candidates. Once the session\n"
            "limit is reached every attempt fails identically, and the harness\n"
            "cannot tell that apart from a candidate that broke the tool: the\n"
            "result event carries `is_error: true` with `subtype: \"success\"`,\n"
            "which is why the check looks at the message rather than the status.\n\n"
            "The run stopped instead of continuing because carrying on would\n"
            "have spent the remaining budget recording zeros, and taught the\n"
            "proposer that every candidate was broken.\n\n"
            "## What to do\n\n"
            "Wait for the quota to reset, then start again. Whatever GEPA had\n"
            "already explored is under `gepa/`.\n"
        )
        print(f"\n[oa] STOPPED: {exc}")
        print(f"[oa] wrote {run_dir / 'ABORTED-QUOTA.md'}")
        print("[oa] no results were produced — this is not a negative result.")
        raise SystemExit(2)
    finally:
        pool.close()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lever", choices=sorted(config.LEVERS), default="tool",
                   help="which single file to evolve (default: tool)")
    p.add_argument("--budget", type=int, default=60,
                   help="how many candidate evaluations to allow (default: 60)")
    p.add_argument("--holdout", type=float, default=0.2,
                   help="fraction of questions kept back to check generalisation")
    p.add_argument("--reflection-lm", default=config.REFLECTION_LM,
                   help="the model that reads the feedback and proposes changes "
                        f"(default: {config.REFLECTION_LM}, via {config.REFLECTION_KEY_VAR})")
    p.add_argument("--workers", type=int, default=1,
                   help="parallel evaluations; each needs its own copy of the tool")
    p.add_argument("--keep-runs", action="store_true",
                   help="save every raw attempt (uses a lot of disk)")
    p.add_argument("--files", nargs="+", metavar="PATH",
                   help="evolve exactly these files instead of the lever's default, "
                        "e.g. --files botmap/filters.py botmap/cli.py")
    p.add_argument("--proposer", choices=("api", "subscription"), default="api",
                   help="who proposes the changes: 'api' bills OPENROUTER_API_KEY, "
                        "'subscription' shells out to `claude -p` and uses your "
                        "Claude Code plan instead")
    p.add_argument("--repo-context-chars", type=int,
                   default=repo_context.DEFAULT_BUDGET_CHARS,
                   help="how much read-only source of the files GEPA may NOT edit to "
                        "include in its context, in characters. 0 turns it off, which "
                        "is the behaviour before this existed — use that to measure "
                        "whether the context helps (default: "
                        f"{repo_context.DEFAULT_BUDGET_CHARS})")
    p.add_argument("--all-files", action="store_true",
                   help="evolve every eligible file in the tool. Widens the search "
                        "beyond what we already know is broken, but splits the budget "
                        "across more files — raise --budget to match.")
    args = p.parse_args()

    chosen = tuple(args.files) if args.files else (
        config.discoverable_files() if args.all_files else None)
    run(args.lever, args.budget, args.holdout, args.reflection_lm,
        args.workers, args.keep_runs, chosen, args.proposer,
        args.repo_context_chars)


if __name__ == "__main__":
    main()
