# Autoresearch Loop for CLI Improvement Proposals — Design

**Date:** 2026-08-14
**Status:** Draft — pending approval

## Problem

`evals/synthesize.py` already turns clustered eval failures into concrete,
evidence-backed proposals: `evals/proposals-4.json` holds 10, each a
`{title, target, evidence, proposal}` naming specific files and line numbers.
Four rounds of these have been produced.

Nothing tests them. A proposal is a hypothesis written by a model reading
failure traces, and some are wrong — `docs/automated-improvements/progress_summary.md`
records exactly this: fixes deployed in round 01→02 closed two coverage gaps
but "revealed a latent path through `categories -t land_use`" and "unmasked
`--json` as a group-level-only flag," so agents moved from one error to
another. Deciding which proposals are real currently costs a human a full
implement-and-rerun cycle each, so in practice they are applied on judgement or
not at all.

This design automates that cycle: take proposals one at a time, apply each to a
clean checkout, measure, and record a verdict with its reason. The deliverable
is a ledger — every proposal tried, whether it earned its keep, and why.

Structurally this follows `github.com/karpathy/autoresearch`, which fixes a
5-minute training budget so "experiments [are] directly comparable regardless
of what the agent changes," constrains edits to a single file to keep "the
scope manageable and diffs reviewable," and keeps or discards on one scalar
metric. The three transferable ideas are **a fixed budget**, **a bounded edit
surface**, and **one number that decides**. What differs is the metric: `val_bpb`
is near-deterministic given a seed, while ours is the behaviour of a stochastic
agent. That difference drives most of the design below.

## Prerequisite

**This loop cannot run until `2026-08-13-command-trace-scoring` lands.** The
decision metric is the weighted objective (correctness 60%, token efficiency
20%, wall-clock 20%), and correctness is computed by `evals/objective.py` from
the `expect:` blocks that plan introduces. `evals/questions-newset.yaml` has
none today.

Concretely, the loop needs from that plan: `evals/canon.py`, `evals/expect.py`,
`evals/objective.py`, and `expect:` blocks on all 30 questions in
`questions-newset.yaml`.

## Scope and key decisions

- **Question bank:** `evals/questions-newset.yaml` — 30 questions, in the
  5/7/6/5/7 tier distribution `evals/prompt.md:100` specifies. The full bank
  runs for every experiment; no per-proposal subsetting, so every arm is
  directly comparable.
- **Repeats: 2, for network resilience.** Overture S3 and the STAC catalog are
  live network dependencies; a repeat exists so a transient failure does not
  discard a question. Repeats are *not* a statistical sample, and the design
  does not treat them as one.
- **Accept rule:** a configurable threshold on the weighted objective, supplied
  by the operator. The loop reports the delta broken into all three components
  and never infers the threshold itself.
- **Isolation:** one `git worktree` per experiment, branched from a pinned
  baseline commit. Experiments never see each other's edits.
- **Edit surface:** the botmap worktree only. The proposal's `target` field
  (`cli` / `skill` / `hint` / `docs`) further bounds it.
- **Agent under test:** unchanged from the existing eval — headless Claude Code
  with the packaged Skill and Bash. botmap is the tool under test; the agent
  uses botmap's commands to obtain data and may post-process with python, jq,
  or anything else. Restricting post-processing would make the tier 4–5
  compound questions unanswerable.
- **Verdicts are recorded, never auto-merged.** An accepted proposal produces a
  written set of apply-steps and a saved patch. Merging stays a human act.

Out of scope: proposing new changes (the loop consumes `proposals-*.json`, it
does not author them), multi-proposal combinations, parallel experiment
execution, auto-merge.

## The comparability problem

Karpathy's loop can hold everything fixed but the code. Ours cannot, and two
sources of drift will silently corrupt verdicts if left alone.

### 1. The Overture release is unpinned — blocking

`botmap/core.py:244` falls back to `get_latest_release()`, which reads the live
STAC catalog on every invocation. There is **no environment variable and no
config file** to pin it. A release landing mid-series means baseline and
treatment were measured against different data, and every verdict from that
point is wrong.

This is not a small perturbation. `evals/findings.md` §6 records that the
current release changed **51 removed categories, 106 added, 214 renamed, and
1,583 hierarchy changes**. A loop spanning ~19 hours of wall-clock has a real
chance of straddling a boundary.

**Pinning the release is a prerequisite task, not a nice-to-have.** The loop
records the pinned release in every ledger entry, and refuses to compare two
arms recorded against different releases.

### 2. Agent stochasticity

The same question, same CLI, run twice, does not produce the same trace. With
repeats set to 2 for flake tolerance rather than sampling, the loop cannot
distinguish a small real gain from run-to-run variation on its own.

The design's answer is to be honest about it rather than to model it:

- The operator sets the threshold; the loop applies it.
- Every ledger entry records the **per-repeat spread** on both arms, so the
  threshold can be calibrated from accumulated evidence rather than guessed.
- Deltas below the threshold are recorded as `INCONCLUSIVE`, never as
  `REJECTED`. A proposal that could not be measured is a different fact from a
  proposal that made things worse, and the ledger must not conflate them.

## Architecture

Deterministic mechanics live in Python; judgement lives in skills driven by
agents. Worktree lifecycle, iteration order, arm caching, and ledger IO are
control flow and belong in code. Reading a proposal and implementing it, or
explaining why a change did not pay off, are judgement and belong to an agent.

```
evals/autoresearch/
  loop.py             # orchestrator: iterate, manage worktrees, append ledger
  arms.py             # run one arm (setup -> run -> score), with baseline cache
  compare.py          # objective delta, per-component split, verdict
  ledger.py           # append-only ledger IO (JSONL + rendered markdown)
  LEDGER.md           # THE DELIVERABLE: every proposal, verdict, reason
  ledger.jsonl        # machine-readable mirror
  accepted/<slug>.md  # apply-steps, written only for ACCEPTED proposals
  experiments/<slug>/
    proposal.json     # the input proposal, copied verbatim
    diff.patch        # what the agent actually changed
    metrics.json      # objective + components, both arms
    runs/             # the eval run dirs for this arm
    notes.md          # the agent's account of what it did
```

### Skills

Five skills, matching the five steps. Each is independently invocable, so a
different agent can own each step and any of them can be delegated to a
subagent.

| Skill | Does | Judgement or mechanics |
|---|---|---|
| `autoresearch` | Runs the program: reads a proposals file, drives the loop, reports at the end | orchestration |
| `autoresearch-setup` | Creates the worktree from the baseline SHA, syncs its venv, pins the release, warms the cache, **and applies the proposal** | judgement (the apply) |
| `autoresearch-run` | Executes the eval batch in the worktree | mechanics |
| `autoresearch-score` | Scores runs, computes the objective, compares against the baseline arm | mechanics |
| `autoresearch-record` | Writes the ledger entry, and the apply-steps file when accepted | judgement (the reason) |

Applying the proposal sits inside `autoresearch-setup` deliberately: setup's job
is to produce *a clean repo in the state under test*, and a worktree without the
change applied is not a testable state. It is the one step that needs real
judgement, since a proposal names files and line numbers that may have moved.

### Per-proposal cycle

1. **Setup.** `git worktree add ../botmap-exp-<slug> <baseline-sha>`, `uv sync`,
   pin the release. A subagent reads the proposal and implements it, touching
   only the surface its `target` names. Run the unit suite; a proposal that
   breaks tests short-circuits to `FAILED_TO_APPLY`.
2. **Run.** The eval batch over all 30 questions × 2 repeats, inside the
   worktree. `evals/runner.py:31 venv_python()` resolves `REPO_ROOT` from
   `__file__`, and the shim runs `$OVERTURE_EVAL_PYTHON -m botmap` — so a
   worktree with its own `.venv` exercises the worktree's code with no change
   to the runner.
3. **Score.** `score.py` then `objective.py`, producing the objective and its
   three components.
4. **Compare.** Against the cached baseline arm. Verdict per the rules below.
5. **Record.** Ledger entry always. Apply-steps file only when accepted.
6. **Teardown.** Save `diff.patch`, then `git worktree remove`.

The baseline arm runs **once per baseline SHA** and is cached — it is identical
for every proposal, so re-running it ten times would burn ~$150 to learn
nothing.

## Verdicts

| Verdict | Condition |
|---|---|
| `ACCEPTED` | Δobjective ≥ threshold, and no component regressed past its own guard |
| `REJECTED` | Δobjective ≤ −threshold |
| `INCONCLUSIVE` | \|Δobjective\| < threshold |
| `FAILED_TO_APPLY` | the proposal could not be implemented, or broke the unit suite |
| `MIXED` | objective improved but a component guard tripped (e.g. correctness up, wall-clock materially worse) |

`MIXED` exists because a single scalar can hide a trade the operator would not
make. A proposal that raises correctness while tripling wall-clock is a real
finding, not a clean win, and collapsing it to `ACCEPTED` would hide the cost.

Every non-accepted verdict carries a written reason. The taxonomy of *why*
mirrors `evals/taxonomy.py`'s treatment of CLI errors — a small closed set,
extended only when a real case does not fit:

- `no_measurable_effect` — applied cleanly, objective moved less than threshold
- `regressed_target` — the questions its evidence named got worse
- `regressed_elsewhere` — named questions improved, others degraded more
- `premise_false` — the evidence's claim about the code or data did not hold
- `already_fixed` — the behaviour it describes no longer reproduces on baseline

`premise_false` is expected to fire. `evals/findings.md` §6 already documents
one case where a stated ideal path was measurably wrong, and proposals are
generated by a model reading traces, not by executing code.

## Data flow

```
proposals-N.json ──> loop.py ──┬──> [baseline arm]  (cached per SHA)
                               │
                               └──> per proposal:
                                      worktree + apply   (autoresearch-setup)
                                            │
                                            v
                                      eval batch         (autoresearch-run)
                                            │
                                            v
                                    score.py + objective.py  (autoresearch-score)
                                            │
                                            v
                                      compare vs baseline
                                            │
                                            v
                                    LEDGER.md + ledger.jsonl (autoresearch-record)
                                    accepted/<slug>.md  [if ACCEPTED]
```

## Error handling

- **Release drift.** Every arm records its pinned release. `compare.py` refuses
  to compare arms whose releases differ, and the loop halts rather than
  producing a corrupt verdict.
- **Transient run failures.** A question whose repeats both fail is excluded
  from the comparison **symmetrically** — dropped from the baseline arm too.
  Excluding it from one side only would bias the delta. Every exclusion is
  named in the ledger entry; silent dropping is what makes a benchmark lie.
- **Worktree leakage.** Teardown runs in a `finally`. Orphaned worktrees are
  reaped on the next start via `git worktree prune`.
- **Cost ceiling.** The loop takes a budget in dollars, tracks spend from the
  `cost_usd` already in each `record.json`, and stops cleanly between
  experiments when the next arm would exceed it — leaving the ledger valid.
- **Interruption.** The ledger is append-only JSONL written after each
  experiment, so a killed loop resumes from the last completed proposal rather
  than restarting.

## Testing strategy

- `compare.py` and `ledger.py` are pure and unit-tested against synthetic
  metrics: each verdict boundary, threshold edges, symmetric exclusion, and a
  release mismatch raising rather than comparing.
- Worktree lifecycle is tested against a scratch git repo, not botmap: create,
  apply a trivial patch, tear down, confirm no residue.
- The loop is exercised end-to-end by a **null-proposal smoke test** — a
  proposal that changes nothing. It must come back `INCONCLUSIVE` with a delta
  near zero. This is the single most valuable test in the design: if a no-op
  change reads as an improvement, the harness is measuring noise and every
  verdict it has produced is void.

## Success criteria

- `just autoresearch evals/proposals-4.json` produces `LEDGER.md` with one
  entry per proposal, each carrying a verdict, the objective delta split across
  all three components, the pinned release, and a written reason.
- Accepted proposals each have an `accepted/<slug>.md` with steps precise
  enough to re-apply without re-deriving them, plus the saved patch.
- The null-proposal smoke test returns `INCONCLUSIVE`.
- Every experiment runs against an identical pinned release, and the loop halts
  rather than comparing across a release boundary.
- A killed loop resumes without repeating completed experiments.
