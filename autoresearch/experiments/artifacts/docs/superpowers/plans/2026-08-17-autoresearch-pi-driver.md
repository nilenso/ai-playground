# Autoresearch pi Driver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the `autoresearch/` scaffold so it runs Karpathy's loop against
botmap: propose → implement on one lever → verify → record. The loop is a pi SDK
program; each of the six roles is a pi subprocess configured by its yaml. The
deliverable is a ledger where every entry carries a verdict, a reason, and the
lever it moved.

**Architecture:** `loop.ts` (pi SDK) owns worktrees, budget, ledger, and
iteration, and exposes four custom tools. `agents/*.yaml` compile to `pi -p
--mode json` invocations. `skills/*.md` load per-role via `--skill`. The Python
side (`evals/`) is reused unchanged for running and scoring.

**Tech Stack:** TypeScript + `@earendil-works/pi-coding-agent` /
`@earendil-works/pi-ai`, Node v22 (installed), `typebox` for tool schemas; the
existing Python `evals/` harness; `git worktree`; `uv`.

**Spec:** `docs/superpowers/specs/2026-08-17-autoresearch-pi-driver-design.md`

**Prerequisites:**
1. `2026-08-13-command-trace-scoring` — `evals/objective.py` and `expect:` blocks
   on all 30 questions. Correctness is 60% of the metric.
2. `2026-08-14-autoresearch-loop` **Tasks 1–4 only** — release pinning,
   `compare.py`, `ledger.py`, worktree lifecycle. Its Tasks 5–7 (Claude Code
   skills, Python `loop.py`, first series) are superseded by this plan.

---

## File Structure

```
autoresearch/
  README.md          # POPULATE: what this is, how to run it
  program.md         # POPULATE: shared system prompt for every role
  prepare.py         # POPULATE: pin release, warm cache, load bank, run_batch(), score()
  train.py           # DELETE: no local analogue; the lever lives in the worktree
  loop.ts            # CREATE: pi SDK orchestrator
  package.json       # CREATE: pi deps, build/run scripts
  tsconfig.json      # CREATE
  src/
    agents.ts        # yaml -> pi CLI flags
    tools.ts         # run_agent, run_batch, score, read_ledger
    lever.ts         # declare + enforce the edit surface
    bridge.ts        # shell into the Python evals harness
  agents/            # POPULATE all 6
    analyst.yaml  implementer.yaml  reviewer.yaml
    worker.yaml   scorer.yaml       aggregator.yaml
  skills/            # POPULATE all 7
    analyse.md  solution-design.md  code-implementation.md
    experiment-execution.md  score.md  aggregate.md  report-generation.md
  experiments/<slug>/  # generated: diff.patch, metrics.json, runs/, sessions/, notes.md
tests/
  test_autoresearch_lever.py     # lever enforcement (python side)
autoresearch/src/__tests__/
  agents.test.ts                 # yaml -> flags
  tools.test.ts                  # run_batch ignores arguments
```

---

### Task 1: Scaffold the TypeScript side

**Files:**
- Create: `autoresearch/package.json`, `autoresearch/tsconfig.json`
- Delete: `autoresearch/train.py`

- [ ] **Step 1: Node project**

```bash
cd autoresearch && npm init -y
npm install @earendil-works/pi-coding-agent @earendil-works/pi-ai typebox
npm install -D typescript tsx @types/node vitest
```

botmap has no `package.json` at the root, so this stays scoped to
`autoresearch/` and does not make the repo a hybrid at the top level.

- [ ] **Step 2: Delete `train.py`**

It has no analogue here — the edited file lives in an isolated botmap worktree,
not beside the loop. An empty `train.py` implies an edit target at a path that
does not exist, and the first agent to read the directory burns a turn finding
that out.

```bash
git rm --cached autoresearch/train.py 2>/dev/null; rm -f autoresearch/train.py
```

- [ ] **Step 3: Commit**

```bash
git add autoresearch/package.json autoresearch/tsconfig.json
git commit -m "Add. typescript scaffold for the autoresearch driver"
```

---

### Task 2: `agents.ts` — yaml compiles to pi flags

**Files:**
- Create: `autoresearch/src/agents.ts`
- Create: `autoresearch/src/__tests__/agents.test.ts`
- Populate: all six `autoresearch/agents/*.yaml`

- [ ] **Step 1: Define the schema and the compiler**

```yaml
model: anthropic/claude-opus-5      # provider/id
thinking: high                       # off|minimal|low|medium|high|xhigh
tools: [read, edit, bash]            # -> -t, an allowlist
skills: [skills/code-implementation.md]
system_prompt_append: program.md
```

compiles to:

```
pi -p --mode json --model anthropic/claude-opus-5:high \
   -t read,edit,bash --skill skills/code-implementation.md \
   --append-system-prompt program.md \
   --session-dir experiments/<slug>/sessions "<task>"
```

Always emit `--no-context-files`: botmap has no root `AGENTS.md` or `CLAUDE.md`
today, but if one appears it would silently enter every role's prompt and make
past and future experiments incomparable.

- [ ] **Step 2: Write the six configs, with tools as the enforcement**

Role permissions are set through `tools`, not through prompt wording — a prompt
instruction not to edit is a request; an absent tool is a guarantee.

| Role | tools | skills |
|---|---|---|
| `analyst` | `read, bash` | `analyse.md`, `solution-design.md` |
| `implementer` | `read, edit, write, bash` | `code-implementation.md` |
| `reviewer` | `read, bash` + `run_agent` | — |
| `worker` | `bash` + `run_batch` | `experiment-execution.md` |
| `scorer` | `bash` + `score` | `score.md` |
| `aggregator` | `read, write` + `read_ledger` | `aggregate.md`, `report-generation.md` |

**`reviewer` has no `edit` or `write`.** It is QA; a reviewer that can patch the
lever can make its own verdict come true.

- [ ] **Step 3: Test**

Table-driven: `model:thinking` shorthand, repeated `--skill`, tools joined with
commas, missing optional fields omitted rather than emitted empty.

Run:
```bash
cd autoresearch && npx vitest run src/__tests__/agents.test.ts
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/src/agents.ts autoresearch/agents autoresearch/src/__tests__
git commit -m "Add. agent configs compiling to pi invocations"
```

---

### Task 3: `lever.ts` — bound the edit surface

**Files:**
- Create: `autoresearch/src/lever.ts`
- Create: `tests/test_autoresearch_lever.py`

- [ ] **Step 1: Declare and enforce**

Two levers, one per experiment:

| Lever | Path | Tests |
|---|---|---|
| `tool` | `botmap/cli.py` | does a better affordance change agent behaviour? |
| `prompt` | `botmap/data/skill.md` | does telling the agent more change agent behaviour? |

After the implementer finishes, check `git diff --name-only` in the worktree
against the declared lever. Anything outside it fails the experiment as
`FAILED_TO_APPLY`.

Run the check **before** the batch. It costs nothing and it happens before the
$15.

An empty diff also fails — an implementer that changed nothing has not produced
a testable state, and would otherwise score as a clean `INCONCLUSIVE` and look
like a measured result.

- [ ] **Step 2: Allow the test file exception**

A `cli.py` change may legitimately need a regression test. Permit the lever plus
`tests/`, and record in the ledger when a test file was touched — the diff is
still reviewable, and refusing tests would push the implementer toward untested
changes.

- [ ] **Step 3: Test**

In-lever passes; out-of-lever fails; empty diff fails; lever + `tests/` passes;
both levers at once fails.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/src/lever.ts tests/test_autoresearch_lever.py
git commit -m "Add. lever enforcement for one-surface experiments"
```

---

### Task 4: `prepare.py` and `bridge.ts` — the fixed harness

**Files:**
- Populate: `autoresearch/prepare.py`
- Create: `autoresearch/src/bridge.ts`

- [ ] **Step 1: `prepare.py` — fixed, never modified by an agent**

Karpathy's `prepare.py` holds "fixed constants, one-time data prep … and
runtime utilities (dataloader, evaluation). Not modified." Same role here:

- assert `BOTMAP_RELEASE` is set, and fail loudly if not
- warm the divisions cache once (`~/.cache/botmap` is outside the worktree, so
  the ~30s index build is paid once for the whole series, not per experiment)
- load `evals/questions-newset.yaml`
- expose `run_batch(worktree)` → run dirs, and `score(runs_dir)` → `ArmMetrics`

- [ ] **Step 2: `bridge.ts` — shell into it**

Thin subprocess wrapper returning parsed JSON. Keep every Python detail behind
it, so the TS side never learns the harness's internals.

- [ ] **Step 3: Commit**

```bash
git add autoresearch/prepare.py autoresearch/src/bridge.ts
git commit -m "Add. fixed experiment harness and python bridge"
```

---

### Task 5: `tools.ts` — the four custom tools

**Files:**
- Create: `autoresearch/src/tools.ts`
- Create: `autoresearch/src/__tests__/tools.test.ts`

- [ ] **Step 1: Define them**

Using `defineTool` from `@earendil-works/pi-coding-agent` with `typebox`
schemas:

| Tool | For | Contract |
|---|---|---|
| `run_agent(role, task)` | reviewer | spawn a pi subprocess from `agents/<role>.yaml`, return its JSON result |
| `run_batch()` | worker | **no parameters** — the fixed bank, 30 × 2, in this worktree |
| `score(runs_dir)` | scorer | `score.py` + `objective.py` → `ArmMetrics` |
| `read_ledger()` | analyst, aggregator | prior entries, so an experiment can see what has been tried |

Worktree lifecycle, budget, and ledger *writes* stay in the loop and are
deliberately not agent-callable.

- [ ] **Step 2: `run_batch` takes no parameters — and that is load-bearing**

```typescript
const runBatch = defineTool({
  name: "run_batch",
  description: "Run the fixed eval batch in this experiment's worktree. " +
    "Takes no parameters: the question bank and repeat count are fixed so " +
    "every experiment is comparable.",
  parameters: Type.Object({}),
  execute: async () => bridge.runBatch(currentWorktree),
});
```

The reviewer decides *whether* to measure, never *what* to measure. A reviewer
that could narrow the bank could make any change look good.

- [ ] **Step 3: Cap and log batch executions**

At most two per experiment — one, plus one retry when a run's `run_status` is an
error. **Every execution is written to the ledger, not just the last one.**
Without that, a reviewer re-running until the number looks favourable is
indistinguishable from one that got a clean result on the first try, and the
series quietly becomes noise-mining.

- [ ] **Step 4: Test**

Assert `run_batch` ignores any arguments an agent attempts to pass — that is a
property of the design, not an implementation detail — and that a third
execution attempt is refused.

- [ ] **Step 5: Commit**

```bash
git add autoresearch/src/tools.ts autoresearch/src/__tests__/tools.test.ts
git commit -m "Add. custom tools for the autoresearch loop"
```

---

### Task 6: The seven skills

**Files:**
- Populate: all seven `autoresearch/skills/*.md`
- Populate: `autoresearch/program.md`

- [ ] **Step 1: `program.md` — the shared baseline**

Karpathy's is "baseline instructions for one agent. Point your agent here and
let it go." Here it is appended to every role, so it holds only what all roles
need: what botmap is, what the objective measures, what a lever is, that the
release is pinned and why, and that verdicts are computed rather than asserted.

Role-specific instruction belongs in that role's skill, not here — anything
added to `program.md` is paid for on every turn of every role.

- [ ] **Step 2: Write the skills**

Each needs `name` and `description` frontmatter — pi extracts those at startup
for the system prompt and loads the body on demand, so the description is what
decides whether the skill is used at all.

| Skill | Owner | Content |
|---|---|---|
| `analyse.md` | analyst | read report + traces, state what is failing and why |
| `solution-design.md` | analyst | turn a diagnosis into a change spec bound to one lever |
| `code-implementation.md` | implementer | apply the spec; stop and report `premise_false` if the code does not match the evidence |
| `experiment-execution.md` | worker | call `run_batch()`; repeats are flake insurance, not a sample |
| `score.md` | scorer | objective + three components; never judge |
| `aggregate.md` | aggregator | assemble the ledger entry |
| `report-generation.md` | aggregator | render `LEDGER.md` in the house report style |

- [ ] **Step 3: Two rules that must appear verbatim**

In `code-implementation.md`: **stop and report `premise_false` if the code does
not match what the evidence describes** — do not improvise a nearby fix.
`evals/findings.md` §6 documents a stated ideal path that was measurably wrong,
and proposals are written by a model reading traces, not by executing code.

In `report-generation.md`: follow the existing house format from
`docs/automated-improvements/report-example-01.md` — summary table, then
`### N. Title _(target: …)_` with `**Evidence:**`. The ledger should read as a
continuation of that series, not a new dialect.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/skills autoresearch/program.md
git commit -m "Add. program baseline and role skills"
```

---

### Task 7: `loop.ts` — the orchestrator

**Files:**
- Create: `autoresearch/loop.ts`
- Populate: `autoresearch/README.md`

- [ ] **Step 1: Wire the SDK session**

```typescript
const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  model: getModel("anthropic", "claude-opus-5"),
  thinkingLevel: "medium",
  customTools: [runAgent, runBatch, score, readLedger],
  modelRuntime,
});
```

Subscribe to `tool_execution_end` and `agent_end` for progress and for the
per-role cost accounting the budget ceiling needs.

- [ ] **Step 2: The per-experiment cycle**

1. worktree from `baseline_sha`; declare the lever
2. `analyst` → change spec
3. `implementer` → diff on the lever
4. **lever check** — fail fast, before spending on a batch
5. `reviewer` → delegates to worker / scorer / analyst / aggregator
6. `compare.py` computes the verdict; the reviewer supplies only the reason
7. ledger append; `accepted/<slug>.md` when accepted
8. save `diff.patch`; remove the worktree in a `finally`

Step 6 is the one to get right: **the verdict is computed, not asserted.** An
agent that could name its own verdict would eventually name the one it expected.

- [ ] **Step 3: `README.md`**

How to run, the prerequisites, the budget (~$15 and ~1.7h per arm; ~$165 and
~19h for ten proposals), and the resume behaviour.

- [ ] **Step 4: Commit**

```bash
git add autoresearch/loop.ts autoresearch/README.md
git commit -m "Add. autoresearch orchestrator loop"
```

---

### Task 8: Null-proposal smoke test, then the first series

- [ ] **Step 1: Null proposal**

Run the loop with a proposal that changes nothing. It must return
`INCONCLUSIVE` with a delta near zero.

**This gates everything.** If a no-op reads as an improvement, the harness is
measuring noise and every verdict it will ever produce is void. Record the
observed delta — that number is the empirical floor and the right basis for
choosing the threshold.

- [ ] **Step 2: Both levers, one proposal each**

Before a full series, run one `tool`-lever and one `prompt`-lever proposal, and
confirm the lever check passes on each and fails when the implementer strays.

- [ ] **Step 3: First series**

`evals/proposals-4.json`, ~11 arms, ~$165, ~19h. Unattended, resumable.

- [ ] **Step 4: Read the ledger grouped by lever**

The point of the two-lever rule. With enough entries, group by lever and see
whether tool changes or prompt changes moved the objective more. Write that
observation into `LEDGER.md`'s header.

- [ ] **Step 5: Commit**

```bash
git add autoresearch/LEDGER.md autoresearch/accepted
git commit -m "Add. first autoresearch series over proposals-4"
```

---

## Verification

1. **Unit** — `npx vitest run` (yaml→flags, `run_batch` ignoring arguments,
   execution cap) and `uv run pytest -m "not integration"` (lever enforcement).
2. **Role isolation** — confirm `reviewer` cannot write: give it a task that
   would require an edit and check it reports inability rather than succeeding.
3. **Lever enforcement** — an implementer that touches both `cli.py` and
   `skill.md` fails before any batch runs.
4. **Null proposal** — returns `INCONCLUSIVE`. Gates everything downstream.
5. **Batch logging** — force a retry and confirm both executions appear in the
   ledger.
6. **Resume** — kill mid-series; restart skips completed experiments.

## Success criteria

- A series runs end to end and produces a ledger where every entry carries a
  verdict, a written reason, and the lever it moved.
- Each role is a reproducible `pi` invocation reconstructable from its yaml.
- The reviewer delegates to worker, scorer, analyst, and aggregator, and can
  neither edit files nor vary the batch.
- Every batch execution appears in the ledger, retries included.
- The null-proposal smoke test returns `INCONCLUSIVE`.
- The ledger can be grouped by lever to show which of tool design and prompt
  design moved the objective more.

## Open risks

**Three agents now sit between the proposal and the verdict.** analyst designs,
implementer applies, reviewer measures — and a misunderstanding at any hop
produces a confident verdict about a change nobody intended. `diff.patch`,
`notes.md`, and every role's session transcript are saved per experiment so this
is auditable, but auditing is after the fact. If early series show verdicts
that do not survive inspection, the fix is to collapse analyst and implementer
into one role rather than to add more review.

**Agent overhead is not free.** The $15 per arm is eval runs only; analyst,
implementer, and reviewer turns add on top. Track it from `agent_end` events
from the first series rather than discovering it at the budget ceiling.
