# Live experiment dashboard

Serves one page per arm plus an overview, re-reading real state on every
request. Nothing is cached except the OpenRouter balance.

```bash
python3 tools/dashboard/dashboard.py --port 8765
```

Then <http://localhost:8765>.

| View | Shows |
|---|---|
| `/` | every arm's status, spend, change counts, baseline state, shared constraints |
| `/arm/<name>` | the lever files being optimised, captured candidate history, live terminal, full diffs, and the botmap clone as a tripwire |
| `/tree` | how each arm searched — GEPA iterations with per-question score bars, Arm A's competing branches |
| `/proposals` | every change that could actually be applied, in one place |

## Two things it does that are not obvious

**It samples the lever files every 4 seconds.** GEPA writes one candidate into
the pool worktree, evaluates it, then resets the tree. Each version exists for
seconds only, so a dashboard that read on request would show an empty diff
almost every time. The sampler snapshots each distinct version to
`lever-history/` so candidates survive the reset.

**The botmap clone section is a tripwire.** Anything appearing there is a
hand-edit to the tool under test, which would invalidate every comparison. It
should always read "clean at base".

## A bug worth remembering

An early version diffed the pool worktree against the *autoresearch* commit,
which does not exist in a botmap checkout. `git diff` failed, returned empty,
and the page rendered a confident "lever files are unmodified" — having never
computed a diff at all.

That is the same failure this project exists to study, in the tool built to
watch for it. There is now a guard that says "cannot diff: <ref> is not a commit
in <tree>" instead of silently showing clean. Do not remove it.
