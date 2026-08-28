# Autoresearch pi Driver — Design

**Date:** 2026-08-17
**Status:** Draft — pending approval

## Relationship to the 2026-08-14 design

`docs/superpowers/specs/2026-08-14-autoresearch-loop-design.md` established the
experiment *semantics*, and those are unchanged and still authoritative:

- release pinning as a hard prerequisite (`botmap/core.py:244` reads the live
  STAC catalog; there is no way to pin it today)
- one git worktree per experiment, branched from a pinned baseline SHA
- the weighted objective (correctness 60 / token efficiency 20 / wall-clock 20)
  as the single deciding number, with an operator-supplied threshold
- verdicts `ACCEPTED` / `REJECTED` / `INCONCLUSIVE` / `MIXED` / `FAILED_TO_APPLY`
- the append-only ledger as the deliverable
- symmetric exclusion, budget ceiling, resume-after-interruption

**This document supersedes only its orchestration layer.** Where 08-14 assumed a
Python orchestrator driving Claude Code skills, the loop is now a pi SDK program
driving pi subprocesses, structured around the roles in `autoresearch/`.

## Problem

`autoresearch/` exists as a scaffold — 15 files, all empty — laying out a shape:
`program.md`, `prepare.py`, `train.py`, `README.md`, six `agents/*.yaml`, seven
`skills/*.md`. It mirrors `github.com/karpathy/autoresearch` with a role
decomposition added on top.

The task is to make it run, against botmap, with pi as the agent runtime.

## Scope and key decisions

- **Driver:** pi SDK (TypeScript) for the loop; pi CLI subprocesses for each
  role. The orchestrator holds loop state and exposes custom tools; every role
  runs as its own `pi -p --mode json` process configured by its yaml.
- **Edit surface:** exactly one **lever** per experiment — either
  `botmap/cli.py` (tool design) or `botmap/data/skill.md` (prompt design),
  never both. The lever is recorded on every ledger entry.
- **Reviewer is a verification sub-orchestrator**, not a peer role. It runs the
  experiment against the implemented change and decides whether the system
  truly improved, delegating to worker, scorer, analyst, and aggregator.
- **Question bank:** `evals/questions-newset.yaml`, 30 questions × 2 repeats.
  Repeats are network-flake insurance, not a statistical sample.

Out of scope: proposing changes outside a lever, combining multiple changes in
one experiment, parallel experiments, auto-merge.

## Why two levers

Karpathy constrains the agent to a single file — `train.py` — because that keeps
"the scope manageable and diffs reviewable." The botmap analogue is not one file
but one **kind of change**:

| Lever | File | What it tests |
|---|---|---|
| tool | `botmap/cli.py` | Does a better affordance — a new verb, a steering hint, a clearer error — change agent behaviour? |
| prompt | `botmap/data/skill.md` | Does telling the agent more, or better, change agent behaviour? |

Recording the lever on every entry makes the ledger answer a question no single
experiment can: **which lever pays?** That is the question the whole botmap
exercise set out to test — whether tool design or prompt design is the more
effective place to spend effort — and it falls out of the series for free,
provided the two are never mixed inside one experiment.

Mixing them would make each experiment cheaper to run and worthless to
interpret, which is exactly the trade Karpathy's single-file rule refuses.

## Structural divergence from Karpathy

One mapping does not survive contact, and pretending otherwise would mislead
whoever picks this up:

| Karpathy | Here |
|---|---|
| `prepare.py` — fixed constants, one-time data prep, runtime utilities. Not modified. | `prepare.py` — pin the release, warm the divisions cache, load the bank, expose `run_batch()` / `score()`. Not modified. |
| `train.py` — the single file the agent edits, sitting beside the loop | **No local analogue.** The edited file lives in an isolated botmap worktree, not in `autoresearch/`. |
| `program.md` — baseline instructions for one agent | `program.md` — same role: the loop's shared system prompt |

`autoresearch/train.py` should therefore be **deleted**, and the levers declared
in `program.md` and loop config instead. Keeping an empty `train.py` would imply
an edit target that does not exist at that path, and the first agent to read the
directory would waste a turn discovering that.

## Architecture

```
autoresearch/
  README.md          # what this is, how to run it
  program.md         # baseline instructions — shared system prompt for every role
  prepare.py         # FIXED: pin release, warm cache, load bank, run_batch(), score()
  loop.ts            # pi SDK orchestrator: state, custom tools, worktrees, ledger
  agents/*.yaml      # 6 role configs; each compiles to pi CLI flags
  skills/*.md        # 7 skills, loaded per-role via --skill
```

### Roles

```
loop.ts  (pi SDK — owns worktrees, ledger, budget, iteration)
  │
  ├─ analyst      analyse.md + solution-design.md   diagnose, then design the change
  ├─ implementer  code-implementation.md            apply it on the declared lever
  │
  └─ reviewer     (QA — verifies the change truly improved the system)
        ├─ worker      experiment-execution.md      run the fixed eval batch
        ├─ scorer      score.md                     compute the objective
        ├─ analyst     analyse.md                   diagnose what the traces show
        └─ aggregator  aggregate.md + report-generation.md   ledger + report
```

The reviewer reaches its sub-agents through a `run_agent(role, task)` custom
tool that `loop.ts` exposes. This is the reason the SDK is the loop layer: the
CLI alone gives no way to hand an agent the ability to spawn a configured
sibling.

### Agent configs compile to pi flags

pi has no agent-definition format, and does not need one — every field maps to a
flag:

```yaml
# agents/implementer.yaml
model: anthropic/claude-opus-5
thinking: high
tools: [read, edit, bash]
skills: [skills/code-implementation.md]
system_prompt_append: program.md
```

```
pi -p --mode json --model anthropic/claude-opus-5:high \
   -t read,edit,bash --skill skills/code-implementation.md \
   --append-system-prompt program.md \
   --session-dir experiments/<slug>/sessions "<task>"
```

`--skill` accepts a file or a directory, so `autoresearch/skills/*.md` load from
where they already sit; they do not need relocating to `.pi/skills/`.

Two role constraints are enforced through `tools`, not through prompt wording:

- **reviewer gets no `edit` or `write`.** It is QA; a reviewer that can patch
  the lever can make its own verdict come true.
- **worker and scorer get no `edit` either.** They measure.

### Custom tools exposed by `loop.ts`

Deliberately few. Everything the loop must control — worktree lifecycle, budget,
ledger writes — stays in the loop and is not agent-callable.

| Tool | Available to | Contract |
|---|---|---|
| `run_agent(role, task)` | reviewer | Spawns a pi subprocess from `agents/<role>.yaml`; returns its JSON result |
| `run_batch()` | worker | Runs the **fixed** batch: `questions-newset.yaml`, 30 × 2, in this experiment's worktree |
| `score(runs_dir)` | scorer | `score.py` + `objective.py` → `ArmMetrics` |
| `read_ledger()` | analyst, aggregator | Prior entries, so an experiment can see what has already been tried |

## Guarding the reviewer

Handing an agent discretion over measurement introduces two failure modes that
a deterministic loop does not have. Both are cheap to close and expensive to
discover late.

- **`run_batch()` takes no arguments.** The reviewer decides *whether* to
  measure, never *what* to measure. A reviewer that could narrow the bank could
  make any change look good.
- **At most two batch executions per experiment** — one, plus one retry when a
  run's `run_status` is an error. **Every execution is written to the ledger,
  not just the last.** Without this, a reviewer that re-runs until the number
  looks favourable is indistinguishable from one that got a clean result, and
  the whole series quietly becomes noise-mining.
- **The verdict is computed, not asserted.** The reviewer supplies the reason;
  `compare.py` supplies the label. An agent that could name its own verdict
  would eventually name the one it expected.

## Data flow

```
proposals-N.json ──> loop.ts ──> per proposal:
                                   │
     worktree(baseline_sha) + lever declared
                                   │
        analyst ──> change spec    │
                                   v
        implementer ──> diff on the lever only
                                   │
                                   v
        reviewer ─┬─> worker ──> run_batch()
                  ├─> scorer ──> score()
                  ├─> analyst ─> diagnose traces
                  └─> aggregator
                                   │
                          compare.py (verdict)
                                   │
                                   v
                    LEDGER.md + accepted/<slug>.md
```

## Error handling

Inherits 08-14's handling of release drift, transient run failures, symmetric
exclusion, budget ceiling, and resume. Added here:

- **A role subprocess that exits non-zero** fails the experiment as
  `FAILED_TO_APPLY` with the captured stderr, rather than being retried — a
  crashed implementer has left the worktree in an unknown state.
- **A diff touching more than the declared lever** fails the experiment. The
  loop checks `git diff --name-only` in the worktree against the lever before
  running the batch, so the check costs nothing and happens before the $15.
- **Session transcripts** for every role land in
  `experiments/<slug>/sessions/`, so a wrong verdict can be traced to the turn
  that caused it.

## Testing strategy

- `agents/*.yaml` → flags compilation is pure and table-tested, including the
  `model:thinking` shorthand and repeated `--skill`.
- The lever check is unit-tested against synthetic `git diff --name-only`
  output: in-lever passes, out-of-lever fails, empty diff fails.
- `run_batch()` ignoring any arguments an agent attempts to pass is tested
  explicitly — it is a security property of the design, not an implementation
  detail.
- End-to-end: the **null-proposal smoke test** from 08-14 still gates
  everything. A proposal that changes nothing must return `INCONCLUSIVE`.

## Success criteria

- `autoresearch/loop.ts` runs a series against `evals/proposals-4.json` and
  produces a ledger whose every entry records the lever alongside the verdict.
- Each role runs as a reproducible `pi` invocation reconstructable from its yaml.
- The reviewer can delegate to worker, scorer, analyst, and aggregator, and
  cannot edit files or vary the batch.
- Every batch execution appears in the ledger, including retries.
- The null-proposal smoke test returns `INCONCLUSIVE`.
- After enough experiments, the ledger can be grouped by lever to show which of
  tool design and prompt design moved the objective more.
