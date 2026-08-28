# Scoring Arm A's winners on autoresearch's bank (for GEPA comparability)

## Why
Arm A optimises against botmap's own 10-question suite; the GEPA arms use
autoresearch's 30-question bank with a different scorer (proxy-v1, weighted
0.6 correctness / 0.2 tokens / 0.2 wallclock). "Did the instructed agent match
GEPA's scaffolding" is not answerable across two different exams, so accepted
winners get re-scored on autoresearch's bank to produce one comparable number.

## Dependency (blocking)
A fresh `experiments/baselines/3009509.json` measured on release 2026-08-19.0.
Arm B is measuring it now and it is shared. The old one was correctly renamed
to `3009509.release-2026-07-22.0.STALE.json` (see README-STALE.md), so
`baseline.load("3009509")` misses until the fresh one lands. Do NOT re-measure
a second baseline -- reuse B's, or the comparison inherits a second yardstick.

## Method
Treat each accepted winner as a GEPA candidate and run it through the same
Evaluator the GEPA arms use, so the number is produced by identical machinery:

1. Keep a pristine checkout pinned at 3009509 for BOTMAP_REPO, separate from
   the Arm A working clone (whose HEAD carries the winner commits). Worktrees
   land at `{BOTMAP_REPO.parent}/botmap-oa-3009509-N`, so put it under a
   directory not shared with ar-b / ar-c to avoid the collision documented
   earlier.
2. Read the winner's changed files as {repo-relative path: text}.
3. `pool = Pool("3009509", files=<the winner's files>)`
   `evaluate = Evaluator(lever, pool, reference=baseline.load("3009509"))`
   then evaluate on the full 30-question bank.
4. Report alongside the GEPA arms' objective for the same sha and release.

## Cost
30 questions x REPEATS=2 = 60 `claude -p` runs per winner, roughly 2 hours at
the current healthy-link rate. Only accepted winners, only at the end.

## Caveat to state in the writeup
The lever sets differ. autoresearch's `tool` lever is cli.py / filters.py /
geocoding.py / introspection.py; its `prompt` lever is data/skill.md. A winner
touching a file outside the chosen lever (e.g. cache.py) cannot be scored by
`Pool.write_candidate`, which refuses paths outside the lever by design. Such a
winner is reportable on botmap's suite only, and that limitation is itself a
finding about the lever design rather than a gap in the winner.

---

## CORRECTION (2026-08-21) — the two-baseline assumption was wrong

An earlier plan of mine proposed running the ceiling/unstable partition (F9)
across "arm B's two baselines" to test whether autoresearch's 30-question bank
shares botmap's defect.

**There is one baseline.** Run 2 was cancelled in favour of arm C's
`--within-run` floor. I asserted two without checking; verified state at the
time of writing:

    experiments/baselines/
      3009509.INCOMPLETE-5of30.json          <- quarantined, 5 of 30 questions
      3009509.release-2026-07-22.0.STALE.json <- wrong data release
      (no canonical 3009509.json)

So the F9 question -- "can autoresearch's bank resolve a candidate, or is every
improvable question also unstable?" -- cannot be answered by comparing two
baselines. It needs whatever within-run repeat structure arm C's floor
provides, and that is arm C's and the orchestrator's call, not mine to propose
to them directly.

**What I can still say without any cross-arm data:** F9 is measured for
botmap's 10-question suite only. It is a fact about that suite. Whether it
generalises to the 30-question bank is OPEN, and the report must say open
rather than implying the wider claim. Do not let the stronger version travel.
