# Autoresearch Loop for CLI Improvement Proposals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume `evals/proposals-N.json` one proposal at a time. Apply each to
a clean worktree, run the 30-question bank, compare the weighted objective
against a cached baseline, and record a verdict with its reason. Produce
`evals/autoresearch/LEDGER.md` — every proposal tried, kept or not, and why —
plus an apply-steps file for each accepted proposal.

**Architecture:** Deterministic mechanics in Python (`loop.py`, `arms.py`,
`compare.py`, `ledger.py`); judgement in five skills driven by agents. One git
worktree per experiment, branched from a pinned baseline SHA. The baseline arm
runs once per SHA and is cached.

**Tech Stack:** Python 3.10+, `git worktree`, `uv` for per-worktree venvs, the
existing `evals/` harness (`runner.py`, `score.py`, `objective.py`), `claude`
CLI headless.

**Spec:** `docs/superpowers/specs/2026-08-14-autoresearch-loop-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-08-13-command-trace-scoring.md`
must land first — specifically `evals/canon.py`, `evals/expect.py`,
`evals/objective.py`, and `expect:` blocks on all 30 questions in
`evals/questions-newset.yaml`. Correctness is 60% of the decision metric and
cannot be computed without them.

---

## Budget

| | |
|---|---|
| One arm | 30 questions × 2 repeats = 60 runs ≈ **$15**, **~1.7h** serial |
| Baseline | one arm per baseline SHA, cached across all proposals |
| 10 proposals | 11 arms ≈ **$165**, **~19h** serial |

Derived from the measured mean of $0.25 and 103s per run. The loop is designed
to run unattended and to resume after interruption, because 19 hours will not
complete in one sitting.

---

## File Structure

```
evals/autoresearch/
  __init__.py
  loop.py             # orchestrator: iterate, worktrees, resume
  arms.py             # run one arm (setup -> run -> score); baseline cache
  compare.py          # objective delta, component split, verdict (pure)
  ledger.py           # append-only ledger IO (pure + IO)
  LEDGER.md           # generated: the deliverable
  ledger.jsonl        # generated: machine-readable mirror
  accepted/<slug>.md  # generated: apply-steps for ACCEPTED proposals
  experiments/<slug>/ # generated: proposal.json, diff.patch, metrics.json, runs/, notes.md
.claude/skills/
  autoresearch/SKILL.md
  autoresearch-setup/SKILL.md
  autoresearch-run/SKILL.md
  autoresearch-score/SKILL.md
  autoresearch-record/SKILL.md
tests/
  test_autoresearch_compare.py
  test_autoresearch_ledger.py
  test_autoresearch_worktree.py
botmap/
  core.py             # MODIFY: honour a pinned release
justfile               # MODIFY: `just autoresearch`
```

---

### Task 1: Pin the Overture release — blocking

**Files:**
- Modify: `botmap/core.py`
- Modify: `botmap/data/skill.md`
- Modify: `tests/test_core.py`

Without this the loop is unsound: `botmap/core.py:244` falls back to
`get_latest_release()`, which reads the live STAC catalog on every call. There
is no env var and no config to pin it. A release landing during a ~19h series
means baseline and treatment measured different data, and every verdict after
that point is wrong. `evals/findings.md` §6 records this release moving 51
removed / 106 added / 214 renamed categories — a boundary is not a small
perturbation.

- [ ] **Step 1: Honour `BOTMAP_RELEASE`**

At the release-resolution point in `botmap/core.py:244`, consult
`os.environ.get("BOTMAP_RELEASE")` before falling back to
`get_latest_release()`. An explicit `-r/--release` on the command line still
wins over the environment; the precedence is flag > env > latest.

Validate the env value through the existing `validate_release` path
(`botmap/cli.py:413`) so an unknown release fails loudly with the same 60-day
retention message, rather than silently resolving to nothing.

- [ ] **Step 2: Test**

Add to `tests/test_core.py`: env var honoured; flag beats env; unset env falls
back to latest; unknown env value raises.

Run:
```bash
uv run pytest tests/test_core.py -v
```
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add botmap/core.py botmap/data/skill.md tests/test_core.py
git commit -m "Add. BOTMAP_RELEASE for reproducible runs"
```

---

### Task 2: `compare.py` — the verdict rules

**Files:**
- Create: `evals/autoresearch/__init__.py`, `evals/autoresearch/compare.py`
- Create: `tests/test_autoresearch_compare.py`

Pure and offline. This module decides everything, so it is built and tested
before anything spends money.

- [ ] **Step 1: Define the arm and the comparison**

```python
@dataclass(frozen=True)
class ArmMetrics:
    objective: float
    correctness: float
    token_efficiency: float
    wallclock: float
    release: str                 # pinned; comparing across releases is refused
    per_question: dict           # qid -> objective, for exclusion + spread
    repeat_spread: dict          # qid -> |r1 - r2|, for threshold calibration
    excluded: list[str]          # questions dropped, both arms

@dataclass(frozen=True)
class Verdict:
    label: str                   # ACCEPTED | REJECTED | INCONCLUSIVE | MIXED | FAILED_TO_APPLY
    delta: float
    components: dict             # per-component deltas
    reason_code: str | None      # no_measurable_effect | regressed_target | ...
    excluded: list[str]
```

- [ ] **Step 2: Implement the rules**

| Verdict | Condition |
|---|---|
| `ACCEPTED` | Δobjective ≥ threshold and no component guard tripped |
| `REJECTED` | Δobjective ≤ −threshold |
| `INCONCLUSIVE` | \|Δobjective\| < threshold |
| `MIXED` | Δobjective ≥ threshold but a component guard tripped |
| `FAILED_TO_APPLY` | set by setup, not computed here |

Threshold and per-component guards come from config — **never inferred**. The
operator sets them; `compare.py` applies them.

Two rules that are easy to get wrong and are the point of the unit tests:

- **Symmetric exclusion.** A question excluded from the treatment arm is
  excluded from the baseline arm too, before either objective is computed.
  Excluding on one side biases the delta by exactly the amount the excluded
  question contributed.
- **Release mismatch raises.** Two arms recorded against different releases are
  not comparable. Raise; do not warn and proceed.

- [ ] **Step 3: Test**

`tests/test_autoresearch_compare.py`: each verdict boundary including exactly-at
threshold; a component guard tripping to produce `MIXED`; symmetric exclusion
changing the delta versus one-sided exclusion; release mismatch raising; an
all-questions-excluded arm degrading to `INCONCLUSIVE` rather than dividing by
zero.

Run:
```bash
uv run pytest tests/test_autoresearch_compare.py -v
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add evals/autoresearch tests/test_autoresearch_compare.py
git commit -m "Add. verdict rules for autoresearch experiments"
```

---

### Task 3: `ledger.py` — the deliverable

**Files:**
- Create: `evals/autoresearch/ledger.py`
- Create: `tests/test_autoresearch_ledger.py`

- [ ] **Step 1: Append-only JSONL plus rendered markdown**

`ledger.jsonl` is written after each experiment and is the resume source of
truth. `LEDGER.md` is re-rendered from it, so a corrupted render never loses
data.

Entry shape:
```json
{"slug": "kleene-qualifier-filter", "title": "...", "target": "cli",
 "verdict": "ACCEPTED", "delta": 0.031,
 "components": {"correctness": 0.048, "token_efficiency": -0.004, "wallclock": 0.002},
 "threshold": 0.02, "release": "2026-07-22.0",
 "baseline_sha": "f9f4d7f", "excluded": ["motorways-rhode-island"],
 "repeat_spread": {"median": 0.011, "max": 0.087},
 "reason_code": null, "reason": "...", "patch": "experiments/.../diff.patch"}
```

`repeat_spread` is carried on every entry so the threshold can be calibrated
from accumulated evidence. It is the only honest way to know whether the
threshold in use is above or below the harness's own noise.

- [ ] **Step 2: Render `LEDGER.md`**

Follow the house report style from `docs/automated-improvements/report-example-01.md`:
a summary table first, then one section per proposal. Section shape mirrors the
existing `### N. Title _(target: cli)_` + `**Evidence:**` convention, extended
with `**Verdict:**`, the component table, and `**Reason:**`.

Summary table:

| # | Proposal | Target | Verdict | Δ obj | Δ correctness | Δ tokens | Δ wall |
|---|---|---|---|---|---|---|---|
| 1 | Fix null-propagating qualifier filter | cli | ACCEPTED | +0.031 | +0.048 | −0.004 | +0.002 |
| 2 | … | hint | INCONCLUSIVE | +0.006 | +0.009 | 0.000 | −0.003 |

- [ ] **Step 3: Test**

Append then resume; re-render is idempotent; a truncated final JSONL line is
skipped rather than crashing the loop.

- [ ] **Step 4: Commit**

```bash
git add evals/autoresearch/ledger.py tests/test_autoresearch_ledger.py
git commit -m "Add. append-only ledger for autoresearch verdicts"
```

---

### Task 4: Worktree lifecycle

**Files:**
- Create: `evals/autoresearch/arms.py`
- Create: `tests/test_autoresearch_worktree.py`

- [ ] **Step 1: Create, sync, tear down**

```
git worktree add ../botmap-exp-<slug> <baseline-sha>
cd ../botmap-exp-<slug> && uv sync
```

The eval harness needs no changes to exercise worktree code:
`evals/runner.py:31 venv_python()` resolves `REPO_ROOT` from `__file__`, and the
shim runs `$OVERTURE_EVAL_PYTHON -m botmap` — so a worktree with its own
`.venv` runs that worktree's botmap. Verify this explicitly in Step 3 rather
than assuming it.

Teardown in a `finally`; `git worktree prune` on startup to reap orphans from
killed runs. Save `diff.patch` **before** removing the worktree.

- [ ] **Step 2: Share the divisions cache**

`botmap/cache.py:20 cache_dir()` is `~/.cache/botmap`, outside the worktree, so
the ~30s index build is paid once rather than per experiment. Confirm this and
warm it once in the loop's startup, not per arm.

- [ ] **Step 3: Test**

Against a scratch git repo, not botmap: create a worktree, apply a trivial
patch, confirm isolation from the parent, tear down, confirm no residue. Then
one manual check that a deliberate change to the worktree's `botmap/cli.py`
is visible to a run executed inside it.

- [ ] **Step 4: Commit**

```bash
git add evals/autoresearch/arms.py tests/test_autoresearch_worktree.py
git commit -m "Add. worktree lifecycle for isolated experiments"
```

---

### Task 5: The five skills

**Files:**
- Create: `.claude/skills/autoresearch/SKILL.md`
- Create: `.claude/skills/autoresearch-setup/SKILL.md`
- Create: `.claude/skills/autoresearch-run/SKILL.md`
- Create: `.claude/skills/autoresearch-score/SKILL.md`
- Create: `.claude/skills/autoresearch-record/SKILL.md`

Each is independently invocable so a different agent can own each step, and any
can be delegated to a subagent.

- [ ] **Step 1: `autoresearch` — run the program**

Frontmatter `description` must state the trigger plainly ("run the autoresearch
loop over a proposals file"). Body: read the proposals file, confirm the
prerequisite modules exist, confirm `BOTMAP_RELEASE` is set, run the baseline
arm if not cached, then iterate. States the budget and the resume behaviour.

- [ ] **Step 2: `autoresearch-setup` — setup the experiment**

Creates the worktree, syncs, pins the release, **and applies the proposal.**
Applying belongs here because setup's job is to produce a clean repo *in the
state under test*, and a worktree without the change applied is not a testable
state.

This is the one step needing real judgement — proposals name files and line
numbers that may have moved, and `evals/proposals-4.json` shows the shape:
"In botmap/geocoding.py:182-184 (`resolve`), replace the null-propagating
`pc.or_` chain with Kleene logic…". Instruct the agent to:

- touch only the surface the proposal's `target` names (`cli` / `hint` /
  `skill` / `docs`);
- re-derive the location if the cited line numbers have drifted, and record
  that in `notes.md`;
- run `uv run pytest -m "not integration"` and report `FAILED_TO_APPLY` if the
  change breaks it;
- **stop and report `premise_false`** if the code does not match what the
  evidence describes — not to improvise a nearby fix. A proposal whose premise
  is wrong is a finding, and `evals/findings.md` §6 shows these are real.

- [ ] **Step 3: `autoresearch-run` — run the experiment**

Mechanics only. Executes the batch inside the worktree over
`evals/questions-newset.yaml`, 2 repeats. Repeats exist for **network
resilience**, not sampling — say so, so no agent later reinterprets them as a
statistical sample. Retry a run whose `run_status` is an error once; if both
repeats fail, mark the question excluded and carry on.

- [ ] **Step 4: `autoresearch-score` — score the results**

Runs `score.py` then `objective.py`, assembles `ArmMetrics`, hands it to
`compare.py`. Mechanics; no judgement about whether the change was good.

- [ ] **Step 5: `autoresearch-record` — write the proposal result**

Appends the ledger entry and re-renders `LEDGER.md`. Writes the **reason**,
which is judgement: for anything not `ACCEPTED`, explain in plain terms why the
proposal did not earn its keep, grounded in the trace, and pick a `reason_code`
from the closed set (`no_measurable_effect`, `regressed_target`,
`regressed_elsewhere`, `premise_false`, `already_fixed`).

For `ACCEPTED`, additionally write `accepted/<slug>.md`: the exact steps to
re-apply, precise enough that nobody re-derives them, plus the measured delta
and a pointer to `diff.patch`.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills
git commit -m "Add. autoresearch skills for the experiment loop"
```

---

### Task 6: `loop.py` and the null-proposal smoke test

**Files:**
- Create: `evals/autoresearch/loop.py`
- Modify: `justfile`

- [ ] **Step 1: Orchestrate**

Iterate proposals in file order. Per proposal: setup → run → score → compare →
record → teardown. Baseline arm runs once per `baseline_sha` and is cached.

Flags: `--proposals PATH`, `--threshold FLOAT`, `--budget-usd FLOAT`,
`--questions PATH` (default `evals/questions-newset.yaml`), `--repeats 2`,
`--resume`.

Budget tracking sums `cost_usd` from each `record.json` and stops cleanly
*between* experiments when the next arm would exceed the ceiling, leaving the
ledger valid rather than truncating an arm.

- [ ] **Step 2: The null-proposal smoke test**

Run the loop with a single proposal that changes nothing. It must return
`INCONCLUSIVE` with a delta near zero.

**This is the most valuable test in the plan.** If a no-op reads as an
improvement, the harness is measuring noise and every verdict it will ever
produce is void. Do not proceed past this step until it passes, and record the
observed delta — that number is the empirical floor, and the right starting
point for choosing the threshold.

Run:
```bash
just autoresearch evals/autoresearch/null-proposal.json --threshold 0.02
```
Expected: one `INCONCLUSIVE` entry; `|delta|` small relative to the threshold.

- [ ] **Step 3: Add the recipe**

```just
# Run the autoresearch loop over a proposals file
[group('eval')]
autoresearch proposals threshold="0.02" budget="200":
    BOTMAP_RELEASE=${BOTMAP_RELEASE:?set BOTMAP_RELEASE to pin the data} \
    uv run python -m evals.autoresearch.loop \
        --proposals {{ proposals }} --threshold {{ threshold }} --budget-usd {{ budget }}
```

The `:?` guard makes an unpinned release fail at the recipe rather than
producing 19 hours of incomparable results.

- [ ] **Step 4: Commit**

```bash
git add evals/autoresearch/loop.py justfile
git commit -m "Add. autoresearch orchestrator and just recipe"
```

---

### Task 7: First real series

**Files:**
- Create: `evals/autoresearch/LEDGER.md` (generated)

- [ ] **Step 1: Calibrate the threshold**

Using the null-proposal delta from Task 6 Step 2 and the `repeat_spread` it
recorded, choose the threshold. Write the chosen number and its justification
into `LEDGER.md`'s header so later readers know what bar the verdicts were held
to.

- [ ] **Step 2: Run against `proposals-4.json`**

10 proposals, ~11 arms, ~$165, ~19h. Run unattended; resume as needed.

- [ ] **Step 3: Review**

Read `LEDGER.md` end to end. Specifically check that any `premise_false`
verdicts are genuinely false premises rather than the setup agent giving up —
that is the failure mode most likely to be mislabelled, and the one that would
quietly discard good proposals.

- [ ] **Step 4: Commit**

```bash
git add evals/autoresearch/LEDGER.md evals/autoresearch/accepted
git commit -m "Add. first autoresearch series over proposals-4"
```

---

## Verification

1. **Offline unit tests** — `just test`. Verdict boundaries, symmetric
   exclusion, release-mismatch raising, ledger append/resume/idempotent render.
2. **Worktree isolation** — a change made in a worktree is visible to a run
   executed inside it, and invisible to the parent checkout.
3. **Null-proposal smoke test** — returns `INCONCLUSIVE`. Gates everything
   downstream.
4. **Release pinning** — two arms recorded against different releases cause the
   loop to halt, not to emit a verdict.
5. **Resume** — kill the loop mid-series; restarting skips completed
   experiments and reproduces the same `LEDGER.md` for those entries.
6. **End-to-end** — `just autoresearch evals/proposals-4.json` produces a
   ledger with one entry per proposal, each with a verdict, a component split,
   and a written reason.

## Success criteria

- `LEDGER.md` holds one entry per proposal: verdict, objective delta split
  across all three components, pinned release, excluded questions, and a
  written reason.
- Every `ACCEPTED` proposal has an `accepted/<slug>.md` with re-appliable steps
  and a saved patch.
- The null-proposal smoke test returns `INCONCLUSIVE`.
- No experiment is ever compared across a release boundary.
- A killed loop resumes without repeating completed experiments.

## Open risks

**Repeats are flake insurance, not a sample.** With 2 repeats the loop cannot
separate a small real gain from run-to-run variation on its own — which is why
the threshold is operator-supplied and why `INCONCLUSIVE` is a distinct verdict
from `REJECTED`. The `repeat_spread` recorded on every entry is the instrument
for calibrating that threshold from evidence. If the null-proposal delta turns
out comparable to the deltas real proposals produce, the honest response is
more repeats on a narrower question set, not a lower threshold.

**The setup agent is a single point of failure.** It both implements the
proposal and judges whether the premise holds. An agent that implements
something subtly different from what the proposal intended produces a verdict
about the wrong change. `diff.patch` and `notes.md` are saved on every
experiment precisely so this is auditable after the fact.
