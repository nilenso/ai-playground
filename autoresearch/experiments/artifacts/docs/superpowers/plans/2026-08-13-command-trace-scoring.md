# Command-Trace Scoring for the Agent-Usability Eval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `evals/` harness to score *whether the agent constructed the
right command*, not whether its answer was right. Add a deterministic argv
canonicalizer, a per-question expectation DSL checked against the captured
`shim.log`, an LLM judge for the tiers where success is a refusal or a
decomposition, a weighted objective (correctness 60 / token efficiency 20 /
wall-clock 20), a held-out split, and a minimal-agent baseline.

**Architecture:** Two new pure modules — `canon.py` (argv → comparable
`CanonCall`, via the real Click tree) and `expect.py` (expectation DSL →
`PathScore`) — sit between the existing `trace.py` parsers and `score.py`.
Both are network-free and fixture-tested, matching the existing pure-module
convention. `judge.py` and `objective.py` run post-hoc over stored artifacts,
so they re-run without touching S3. A second runner backend
(`agents/minimal.py`) writes the same run-dir shape so every downstream module
works unchanged.

**Tech Stack:** Python 3.10+, Click (reused for parsing, not re-implemented),
PyYAML for the bank, `claude` CLI (headless) and the Messages API for the two
agent backends, pytest for the pure modules.

**Spec:** `docs/superpowers/specs/2026-08-13-command-trace-scoring-design.md`
(written in Task 1)

---

## Context

The CLI was redesigned around a thesis: question-shaped verbs, with `download`
as an escape hatch. `docs/superpowers/specs/2026-05-28-agent-usability-eval-design.md:38`
scoped v1 to "process signals only — no answer-correctness judging in v1; the
final answer text is recorded so correctness can be layered in later without
re-running." Four improvement rounds have run against that v1
(`docs/automated-improvements/progress_summary.md`: download rate 35% → 15%,
avg commands per run −22%).

This is that layering — but the thing to layer in is **command correctness**,
not answer correctness. The question under test is whether the agent picks the
right verb and filter from a natural-language query. That makes the ground
truth the command trace, which `evals/shim/botmap` already captures in full,
and sidesteps answer keys going stale as Overture ships monthly releases.

Today `evals/score.py:41` defines `completed` as "the stream-json result event
was non-error and non-empty" — a confidently wrong command that returns a
plausible number scores identically to the ideal one, which is precisely what
`evals/prompt.md:136` says the eval exists to catch. Two fields that already
encode the right answer, `target_type` and `subtasks` (18 questions), are read
by no code at all.

## Decisions taken

| Decision | Choice |
|---|---|
| Correctness | **Hybrid** — deterministic canonical matcher for tiers 1–2; LLM judge for tiers 3–5 |
| Data backend | **Live S3, serial runner** — no replay cache, no worker pool; wall-clock is 20% of the objective and parallel S3 contention would distort per-run latency |
| Scope | **Extend the existing global bank** to 100 (Monaco, Malta, Rome, Boston, Vancouver, Seattle, Providence, NYC…) |
| Agent harness | **Both** — keep headless `claude -p`, add the minimal agent as a second backend |

Measured from the 40 `record.json` files on disk: mean **$0.25** and **103s**
per run (p90 255s, max 859s). One full iteration at 100 questions × 2 repeats
is therefore ≈ **$50 and ~5.7h serial**.

Out of scope: replay/record caching, runner parallelism, multi-model
comparison, CI integration, auto-applied patches.

---

## File Structure

```
evals/
  canon.py               # argv -> CanonCall (pure)
  expect.py              # expectation DSL + matcher -> PathScore (pure)
  judge.py               # LLM judge, tiers 3-5, 3-sample median
  objective.py           # weighted 60/20/20, per-question normalization (pure)
  reference.json         # generated; best-observed tokens/duration per question
  agents/
    __init__.py
    minimal.py           # minimal Pi-style agent backend
  questions.py           # MODIFY: validate `expect`/`split`, enforce no-`__` ids
  score.py               # MODIFY: path fields on Record
  trace.py               # MODIFY: dispatch usage parsing on runner kind
  runner.py              # MODIFY: bank-namespaced run dirs, --agent flag
  synthesize.py          # MODIFY: objective + train/test breakdown
  questions.yaml         # MODIFY: consolidated 100-question bank
  runs/<bank>/<id>__r<n>/  # CHANGED: namespaced by bank stem
tests/
  test_eval_canon.py
  test_eval_expect.py
  test_eval_objective.py
  eval_fixtures/
    canon_pairs.yaml     # equivalence / non-equivalence tables
docs/superpowers/specs/
  2026-08-13-command-trace-scoring-design.md
docs/automated-improvements/
  report-example-05.md   # first round scored on command-path correctness
  progress_summary.md    # MODIFY: extend trend tables with path + objective
```

---

### Task 1: Design spec and bank schema

**Files:**
- Create: `docs/superpowers/specs/2026-08-13-command-trace-scoring-design.md`
- Modify: `evals/questions.py`
- Modify: `tests/test_eval_questions.py`

- [ ] **Step 1: Land the design spec**

Write Part 1 of this document to
`docs/superpowers/specs/2026-08-13-command-trace-scoring-design.md`, and this
Part 2 to `docs/superpowers/plans/2026-08-13-command-trace-scoring.md`. Flip the
spec's `**Status:**` from `Draft — pending approval` to `Approved for planning`,
matching the two existing specs.

- [ ] **Step 2: Extend the bank loader**

In `evals/questions.py`, add to `load_questions`:

- `split` — optional, must be `"train"` or `"test"`; defaults to `"train"`.
- `expect` — optional mapping; when present, validate it has at least one of
  `accept` / `require_all` / `forbid`, that each is a list of mappings, and that
  `allow_extra` (if present) is a list of strings.
- **Enforce the no-`__`-in-id rule.** `evals/README.md:33` documents it because
  `__` delimits run directories, but no code checks it.

Keep the existing fail-fast style: `SystemExit` naming the offending file and
index, matching the messages already asserted in `tests/test_eval_questions.py`.

- [ ] **Step 3: Test the new validation**

Add to `tests/test_eval_questions.py`, one test per failure mode, matching the
existing one-`SystemExit`-message-per-test convention: id containing `__`,
`split` not in `{train, test}`, `expect` with no recognized key, `expect.accept`
not a list.

Run:
```bash
uv run pytest tests/test_eval_questions.py -v
```
Expected: green, including the pre-existing 9 tests.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs evals/questions.py tests/test_eval_questions.py
git commit -m "Add. command-trace scoring design spec and bank schema"
```

---

### Task 2: `canon.py` — argv → canonical form

**Files:**
- Create: `evals/canon.py`
- Create: `tests/test_eval_canon.py`
- Create: `tests/eval_fixtures/canon_pairs.yaml`

- [ ] **Step 1: Write the canonicalizer**

The parsing spine below is **prototyped and verified** against the real CLI:

```python
import click
from click.core import ParameterSource
from botmap.cli import cli, TYPE_TO_VERB
from botmap.filters import parse_where_expr

def _parse(argv: list[str]):
    ctx = click.Context(cli)
    _, rest, _ = cli.make_parser(ctx).parse_args(list(argv))  # absorbs group --json
    if not rest:
        return None, {}, "no-subcommand"
    name, sub_args = rest[0], rest[1:]
    cmd = cli.get_command(ctx, name)
    if cmd is None:
        return name, {}, "unknown-command"
    sub = click.Context(cmd, parent=ctx)
    try:
        cmd.parse_args(sub, list(sub_args))
    except click.ClickException as exc:
        return name, {}, f"parse-fail: {exc.format_message()}"
    explicit = {
        k: v for k, v in sub.params.items()
        if sub.get_parameter_source(k) is not ParameterSource.DEFAULT
    }
    return name, explicit, None
```

`ParameterSource` filtering is load-bearing. Without it every call carries
`release='2026-07-22.0'` and `output_format='geojsonseq'`, and nothing ever
compares equal.

```python
@dataclass(frozen=True)
class CanonCall:
    verb: str                 # 'count' | 'places' | 'download' | 'where' | ...
    intent: str               # count | fetch | inspect | resolve | meta
    type: str | None          # lowered from the verb, or read from -t
    scope: tuple              # ('in', 'brooklyn') | ('bbox', ...) | ('point', lat, lon)
    filters: frozenset        # {('categories.primary', '=', 'coffee_shop')}
    raw_place: str | None     # the un-normalized --in string, for the report
    malformed: str | None     # parse failure reason, kept rather than discarded
```

- [ ] **Step 2: Implement the lowering rules**

These *are* the equivalence classes and are the substance of the module:

- verb → type by inverting `botmap/cli.py:310 TYPE_TO_VERB` (`places`→`place`,
  `buildings`→`building`, `roads`→`segment`, `water`, `landuse`→`land_use`,
  `addresses`→`address`).
- `--category X` → filter `('categories.primary', '=', X)`. `botmap/cli.py:321
  _suggest_verb_command` already performs exactly this rewrite in the reverse
  direction — import the mapping from there rather than restating it, so the two
  cannot drift.
- `--class X` → `('class', '=', X)`; `--street` / `--number` / `--postcode` →
  their field filters.
- `--where` parsed with `botmap/filters.py:105 parse_where_expr` →
  `ParsedFilter(key, op, value)`. Do not hand-roll a parser; `count --json`
  already emits this exact shape.
- Place names: casefold, then compare on the first comma-segment, so
  `Manhattan, US-NY`, `Manhattan, NY` and `Manhattan` unify. Keep the original
  in `raw_place`. Document this as a deliberate simplification in the module
  docstring.
- `intent`: `count` → count; `places`/`buildings`/`roads`/`water`/`landuse`/
  `addresses`/`sample`/`download`/`gers` → fetch; `schema`/`categories`/`types`/
  `themes`/`capabilities` → inspect; `where`/`boundary`/`containing`/`at` →
  resolve; `cache`/`releases`/`changelog`/`install-skill` → meta.

- [ ] **Step 3: Write the equivalence fixtures**

`tests/eval_fixtures/canon_pairs.yaml` holds two tables. Seed `equivalent` with
these, which the prototype confirms canonicalize identically:

```yaml
equivalent:
  - ["--json count -t building --in 'Manhattan, US-NY' --where 'height>150'",
     "count --type building --where 'height>150' --in Manhattan"]
  - ["places --category coffee_shop --in Brooklyn",
     "places --where categories.primary=coffee_shop --in Brooklyn"]
  - ["places --category coffee_shop --in Brooklyn -n 5",
     "places --category coffee_shop --in Brooklyn"]      # limit is not identity
distinct:
  - ["count -t place --in Brooklyn", "count -t building --in Brooklyn"]
  - ["places --category coffee_shop --in Brooklyn", "places --category cafe --in Brooklyn"]
  - ["count -t place --in Brooklyn", "places --in Brooklyn"]   # count vs fetch
malformed:
  - "download -t place --bbox -74,40,-73,41"    # missing required -f
  - "frobnicate --in X"
```

- [ ] **Step 4: Test**

`tests/test_eval_canon.py` is table-driven off the fixture: every `equivalent`
pair must produce equal `CanonCall`s, every `distinct` pair must not, every
`malformed` entry must yield a non-`None` `malformed` field rather than raising.

Run:
```bash
uv run pytest tests/test_eval_canon.py -v
```
Expected: green, no network access.

- [ ] **Step 5: Commit**

```bash
git add evals/canon.py tests/test_eval_canon.py tests/eval_fixtures/canon_pairs.yaml
git commit -m "Add. canonical form for captured CLI invocations"
```

---

### Task 3: `expect.py` — the expectation DSL and matcher

**Files:**
- Create: `evals/expect.py`
- Create: `tests/test_eval_expect.py`

- [ ] **Step 1: Define the DSL**

A new optional `expect:` block per question. Absent → no path score, so the bank
backfills incrementally rather than in one commit.

```yaml
- id: coffee-brooklyn-count
  tier: 1
  split: train
  expect:
    accept:                            # any one match => full path credit
      - {intent: count, type: place, scope: {in: brooklyn},
         filters: ["categories.primary=coffee_shop"]}
    forbid:
      - {verb: download}
    allow_extra: [where, schema, categories, types, capabilities]
```

Semantics:

- `accept` — tiers 1–2. Any one match earns full credit.
- `require_all` — tiers 4–5. Every listed form must appear, order-free; credit is
  `matched / len(require_all)`. This is where the currently-dead `subtasks` field
  (18 questions) becomes checkable.
- `forbid` — any match is a path violation. Tier 3 uses this alone
  (`forbid: [{intent: fetch}]`), since success there is a refusal.
- `allow_extra` — discovery verbs that cost no credit. Default to the `inspect`
  and `resolve` intents so it rarely needs stating.

A form matches a `CanonCall` when every key the form *specifies* matches;
unspecified keys are wildcards. `filters` matches as a subset, so a question can
require `categories.primary=coffee_shop` without caring that the agent also
passed a bbox.

- [ ] **Step 2: Emit `PathScore`**

| field | meaning |
|---|---|
| `path_hit` | an `accept` form appears anywhere in the trace |
| `path_first_try` | the first non-`allow_extra` call matched an accept form |
| `path_violations` | list of `forbid` forms that appeared |
| `path_coverage` | for `require_all`, fraction matched |
| `path_wasted` | calls that are neither accepted, allowed-extra, nor clean discovery |

`path_first_try` is the sharpest agent-first signal in the whole harness — it
separates "found it" from "groped until it worked", which the current
`command_count` metric only hints at.

- [ ] **Step 3: Test**

`tests/test_eval_expect.py`, pure and offline: accept-hit, accept-miss,
first-try true vs false, `require_all` partial credit, forbid-triggered, and
`allow_extra` not counting against `path_wasted`.

Run:
```bash
uv run pytest tests/test_eval_expect.py -v
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add evals/expect.py tests/test_eval_expect.py
git commit -m "Add. expectation DSL and path matcher"
```

---

### Task 4: Wire path scoring into `score.py` and backfill the bank

**Files:**
- Modify: `evals/score.py`
- Modify: `evals/questions.yaml` (and the `questions-tier*.yaml` banks)
- Modify: `tests/test_eval_score.py`

- [ ] **Step 1: Extend `Record`**

Add the `PathScore` fields to the `Record` dataclass (`evals/score.py:26`) and
populate them in `score_run` by canonicalizing `calls` and matching against
`question["expect"]`. When `expect` is absent, write `None` for each so old runs
and un-backfilled questions stay distinguishable from genuine zeros.

- [ ] **Step 2: Verify each premise, then backfill expectations**

Every existing entry's `notes` spells out the ideal command with real flags —
`evals/prompt.md:120` mandated it. **Do not translate them verbatim.**

`evals/findings.md` §6 establishes that at least one is wrong:
`asian-restaurants-rollup-vancouver` gives its ideal path as
`--where 'categories.primary=asian_restaurant'`, which returns **23** in
Cambridge MA against a true **224**, because `categories.primary` stores only
the leaf of a 6-level tree and `asian_restaurant` is an interior node with a
55-category subtree. Encoding that `notes` line as the accepted form would make
the eval **reward a ~10× undercount and penalise the correct answer** — the
exact inversion this whole plan exists to prevent.

So each `notes` line is a claim to be checked before it becomes an expectation:

- Category slugs are checked against `evals/overture_categories.csv` (2,354
  categories, levels 0–5), not against sampling. §6's cross-check shows why:
  `bus_stop` "appears nowhere in the sheet, in any level, under any name," yet
  `botmap/data/skill.md` documents it in three places and
  `busstops-coffee-williamsburg` is built on it.
- Interior-node categories get an `accept` form that permits **either** the
  hierarchy rollup or an explicit union of leaves — never the bare interior-node
  equality, which is silently wrong.
- Where a question's premise is false outright, fix the question. A case built
  on a false premise trains the eval against correct behaviour, which
  `evals/prompt.md:70` already states as a rule for authoring the bank; it
  applies with more force to authoring the answer key.

Tier 3 entries get `forbid` only.

- [ ] **Step 2a: Record premise corrections as findings**

Any `notes` line corrected here is a CLI or Skill defect, not just an eval fix.
Append each to `evals/findings.md` in its existing numbered form (severity,
evidence, worked example) so the correction is visible to the CLI work rather
than buried in a YAML diff.

- [ ] **Step 3: Validate against the 40 runs already on disk**

Re-score the existing `evals/runs/` and hand-check two known cases from
`docs/automated-improvements/progress_summary.md`:

- `tall-buildings-manhattan__r1` ran `count -t building --where 'height>150'`
  then a `buildings` fetch → `path_hit` true, `path_first_try` true.
- `busstops-coffee-williamsburg` reached for `download -t infrastructure` →
  `path_violations` non-empty.

If those two don't fall out correctly, the matcher is wrong. Do not proceed.

Run:
```bash
uv run python -m evals.score --questions evals/questions.yaml
```
Expected: every run scored; the two assertions above hold.

- [ ] **Step 4: Commit**

```bash
git add evals/score.py evals/questions.yaml evals/questions-tier*.yaml tests/test_eval_score.py
git commit -m "Update. score command-path correctness from the shim trace"
```

---

### Task 5: `judge.py` — LLM judge for tiers 3–5

**Files:**
- Create: `evals/judge.py`
- Modify: `evals/score.py`

- [ ] **Step 1: Implement the judge**

Post-hoc over stored artifacts only, so it re-runs without touching S3. Input:
question text, `notes` (which already names both the ideal path *and* the
plausible failure mode for all 64 existing entries), `subtasks`, the
canonicalized trace, `final_answer`, and CLI stderr.

Structured output:
```json
{"path_grade": 0,
 "named_the_unsupported_thing": true,
 "offered_a_retryable_alternative": true,
 "rationale": "..."}
```

Follow the existing `evals/synthesize.py` convention for the LLM call (opus via
`claude -p`), so there is one way to invoke a model in this harness.

- [ ] **Step 2: Sample three times and report disagreement**

Take 3 samples and use the median. **Record the inter-sample disagreement rate
and surface it in the report.** If the judge does not agree with itself, its 60%
weight on tiers 3–5 is not meaningful — see Open Risk below.

- [ ] **Step 3: Commit**

```bash
git add evals/judge.py evals/score.py
git commit -m "Add. llm judge for refusal and decomposition tiers"
```

---

### Task 6: `objective.py` — the weighted score

**Files:**
- Create: `evals/objective.py`
- Create: `tests/test_eval_objective.py`

- [ ] **Step 1: Implement**

- correctness 60% — deterministic `path_hit` / `path_coverage` for tiers 1–2 and
  for the `forbid` half of tiers 3–5; judge `path_grade` for the rest.
- token efficiency 20% and wall-clock 20% — normalized **per question** as
  `min(1, ref / actual)`, with `ref` the best value observed for that question,
  persisted in `evals/reference.json`.

Per-question normalization is not incidental: fleet-wide normalization would let
tier-5 questions, which legitimately cost 4–10× a tier-1 question, dominate both
efficiency terms and swamp the correctness signal.

Note in the module docstring that `reference.json` is a ratchet — it only ever
improves — so efficiency scores are comparable across iterations but not
absolute.

- [ ] **Step 2: Test**

Pure and offline: weight arithmetic, a question with no `ref` yet, `actual`
better than `ref` clamping to 1.0, a run with `run_status: error` scoring zero
rather than dividing by zero.

Run:
```bash
uv run pytest tests/test_eval_objective.py -v
```
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add evals/objective.py tests/test_eval_objective.py
git commit -m "Add. weighted objective over correctness, tokens, and wall-clock"
```

---

### Task 7: Run-dir namespacing and the held-out split

**Files:**
- Modify: `evals/runner.py`
- Modify: `evals/score.py`
- Modify: `evals/synthesize.py`

- [ ] **Step 1: Fix the run-dir collision — before the bank grows**

`evals/runner.py:89` writes `runs/<id>__r<n>`, which is bank-agnostic, while
`questions-tier6.yaml` reuses ids from `questions-tier1..5.yaml` (e.g.
`hospitals-count-rhode-island` appears in both with different `notes`).
`evals/score.py:135` will happily score a stale run against a new bank's flags.
Namespace by bank stem: `runs/<bank>/<id>__r<n>/`. Update the glob in
`score.py:135` and the loader in `synthesize.py` to match.

This is listed before the bank work deliberately — consolidating the banks in
Task 9 makes the collision far more likely, not less.

- [ ] **Step 2: Report train and test separately**

`synthesize.py` generates proposals from **train only**, and reports the
held-out delta in its own section. This is the guard against the loop optimizing
the questions instead of the CLI. The section layout itself is Task 10.

- [ ] **Step 3: Commit**

```bash
git add evals/runner.py evals/score.py evals/synthesize.py
git commit -m "Fix. namespace run dirs by bank and split train from held-out"
```

---

### Task 8: `agents/minimal.py` — the minimal baseline

**Files:**
- Create: `evals/agents/__init__.py`, `evals/agents/minimal.py`
- Modify: `evals/runner.py`, `evals/trace.py`

- [ ] **Step 1: Build the minimal agent**

A small observe/act loop over the Messages API: one `bash` tool, a short system
prompt, the same temp workdir and the same PATH shim — so `shim.log` is
identical in shape and `canon.py` / `expect.py` work on it unchanged. Model
`claude-sonnet-5`, matching the current `sonnet` alias default.

- [ ] **Step 2: Make usage parsing polymorphic**

`evals/trace.py:88` reads usage from the stream-json `result` event and is
Claude-Code-specific. Write the runner kind into the run dir and dispatch on it,
so the minimal agent emits its own `Usage` from Messages API response fields
rather than being forced to fake a stream-json envelope.

- [ ] **Step 3: Add `--agent` and confirm parity**

Add `--agent {claude-code,minimal}` to `runner.py`. Run both backends over the
same 10-question subset and confirm both `shim.log`s parse identically through
`canon.py`.

- [ ] **Step 4: Commit**

```bash
git add evals/agents evals/runner.py evals/trace.py
git commit -m "Add. minimal agent backend as the baseline arm"
```

---

### Task 9: Consolidate and grow the bank to 100

**Files:**
- Modify: `evals/questions.yaml`
- Delete: `evals/questions-tier1..6.yaml`
- Modify: `evals/prompt.md`

- [ ] **Step 1: Consolidate onto `questions-newset.yaml`**

`evals/questions-newset.yaml` is the current best bank — 30 questions in exactly
the distribution `evals/prompt.md:100` specifies (5/7/6/5/7 across tiers 1–5),
produced by the full probe-then-write pass whose output is `evals/findings.md`.
Make it the base of `questions.yaml` rather than merging the older tier files
into it.

From the 7 older banks (64 entries, ~39 unique), pull forward only questions
`questions-newset.yaml` does not already cover, resolving the id collisions
surfaced in Task 7. Drop the rest — several encode premises `findings.md` has
since disproved.

- [ ] **Step 2: Grow to 100, adding a colloquial-vocabulary axis**

Use the two-phase generator at `evals/prompt.md`, updated to emit `expect:`
blocks alongside `notes`. Note that most Phase 1 probe artifacts have been
cleaned up — `probe.log`, `findings.md` and `overture_categories.csv` remain,
but the `schema_*.json` / `capabilities.json` dumps do not and must be
regenerated.

`docs/automated-improvements/proposal-category-vocabulary.md` identifies a gap
the current banks barely exercise: *"only `category-tattoo-near-me` uses a
colloquial term, and it fails for an unrelated reason."* Users say "petrol
pump", the taxonomy says `gas_station`; passing the user's phrase through
returns zero rows and the agent reports "none found" — an exit-0 wrong answer,
precisely the class `## Ranked path failures` was added to catch. Add questions
phrased the way users actually speak, each with a verified taxonomy value in its
`expect` block.

- [ ] **Step 3: Assign the split deliberately**

80/20 train/test, **not random**. The test split must contain at least one
question per tier, at least one `download_is_legitimate: true` case, and at
least one colloquial-vocabulary case, or the held-out numbers are noise rather
than a generalization check.

- [ ] **Step 4: Commit**

```bash
git add evals/questions.yaml evals/prompt.md evals/findings.md evals/overture_categories.csv
git rm evals/questions-tier*.yaml evals/questions-newset.yaml
git commit -m "Update. consolidate question banks into a 100-question set"
```

---

### Task 9a: `--skill` flag on the runner

**Files:**
- Modify: `evals/runner.py`

`docs/automated-improvements/proposal-category-vocabulary.md` closes on the
blocker for its own A/B: *"A per-run `--skill` flag on the runner would make
this and future Skill proposals testable without mutating the packaged file.
Not proposed here."*

- [ ] **Step 1: Add it**

`evals/runner.py:57 install_skill` writes `packaged_skill_text()`
(`botmap/data/skill.md`) into each run's workdir. Add `--skill PATH` to read a
variant file instead, defaulting to the packaged text so existing behaviour is
unchanged.

Record the resolved skill path (and its hash) in the run dir, so a report can
never attribute a delta to the wrong prompt.

- [ ] **Step 2: Commit**

```bash
git add evals/runner.py
git commit -m "Add. --skill flag for A/B testing skill variants"
```

---

### Task 10: Report sections and the progress summary

**Files:**
- Modify: `evals/synthesize.py`
- Create: `docs/automated-improvements/report-example-05.md`
- Modify: `docs/automated-improvements/progress_summary.md`

The existing report format is well-established across
`docs/automated-improvements/report-example-01..03.md` and must be **extended,
not replaced** — the whole value of `progress_summary.md` is that round N is
comparable to round 1.

- [ ] **Step 1: Widen the per-question table**

`## Per-question rates` keeps its existing columns (Tier, Runs, Download,
Unnecessary DL, Error, Completed, Avg cmds) and gains four:

| Question | Tier | Runs | … | Path hit | First try | Coverage | Objective |
|---|---|---|---|---|---|---|---|
| coffee-brooklyn-count | 1 | 2 | … | 100% | 100% | — | 0.94 |
| busstops-coffee-williamsburg | 5 | 2 | … | 50% | 0% | 2/3 | 0.41 |

`Coverage` is `—` for questions using `accept` rather than `require_all`.

- [ ] **Step 2: Add `## Ranked path failures`**

The direct analogue of the existing `## Ranked error clusters`, and the section
this whole plan exists to produce. Cluster by (question × the canonical form the
agent actually used), rank by frequency, and show the accepted form beside it —
so a wrong-but-clean command is finally visible where today it is invisible:

```
- **wrong-verb** in `landuse-brooklyn` ×2
  - used:     categories -t land_use --in brooklyn
  - accepted: landuse --in brooklyn --class residential
- **wrong-filter-field** in `restaurant-categories-brooklyn` ×1
  - used:     places --where category=restaurant --in brooklyn
  - accepted: places --where categories.primary=restaurant --in brooklyn
```

Note the class of failure this surfaces that `## Ranked error clusters` cannot:
both examples above **exit 0**. They are today counted as clean runs.

- [ ] **Step 3: Add `## Judge stability` and `## Held-out delta`**

`## Judge stability` reports the 3-sample disagreement rate from Task 5, per
tier. `## Held-out delta` reports the objective on train vs test side by side —
placed immediately before `## Proposed improvements`, so a reader hits the
generalization number before the proposals drawn from train.

- [ ] **Step 4: Keep the proposal format unchanged**

`## Proposed improvements` retains its exact existing shape — `### N. Title
_(target: cli|skill|hint)_`, a `**Evidence:**` line, then one paragraph naming
the concrete files and line numbers to change. It is the most useful part of the
existing reports precisely because it is specific; the only change is that
evidence may now cite a path failure rather than an error cluster.

- [ ] **Step 5: Extend the progress summary in place**

`docs/automated-improvements/progress_summary.md` keeps its structure —
`## Fleet-wide aggregate trends`, `## Per-question trends`, `## What drove each
round's changes` (with per-round "Fixes deployed" / before-after table / "New
problems exposed"), `## Unnecessary download rate: why it's stuck at 15%`,
`## Expected impact of the changes just deployed`, `## Persistent problem
questions`.

Add rows to the fleet-wide table rather than restructuring it:

| Metric | Report 01 | 02 | 03 | 04 | 05 | Change |
|---|---|---|---|---|---|---|
| Download rate | 35.0% | 15.0% | 15.0% | … | … | |
| Error rate | 25.0% | 20.0% | 20.0% | … | … | |
| **Path hit rate** | — | — | — | — | … | new |
| **First-try rate** | — | — | — | — | … | new |
| **Weighted objective** | — | — | — | — | … | new |

Rounds 01–04 carry `—` for the new metrics; **do not back-fill them by
re-scoring**. The archived runs predate several CLI changes, so a retroactive
path score would compare an old agent against a current CLI and read as progress
that never happened. Say so in a footnote.

- [ ] **Step 6: Commit**

```bash
git add evals/synthesize.py docs/automated-improvements
git commit -m "Add. path-failure and objective sections to the eval report"
```

---

### Task 11: Recipes, README, and self-review

**Files:**
- Modify: `justfile`, `evals/README.md`

- [ ] **Step 1: Add recipes**

Add `eval-minimal`, and expose `--repeats` on `eval` (currently hardcoded to the
runner's default of 2 and not reachable from `just`). Keep the existing
model-then-bank argument order on `eval` so current invocations don't break.

- [ ] **Step 2: Update the README**

Document the `expect` block, the split, the objective and its weights, the
per-question normalization ratchet, and the two agent backends. Extend the
existing "Reading the output" section rather than starting a new one.

- [ ] **Step 3: Full suite**

Run:
```bash
uv run pytest -m "not integration"
```
Expected: green — no regressions in the 309 existing tests.

- [ ] **Step 4: Live smoke, then a train-split batch**

Run:
```bash
just eval-smoke evals/questions.yaml
just eval sonnet evals/questions.yaml
```
Expected: the objective is computed, and the held-out delta is reported in its
own section, separately from the train numbers the proposals were drawn from.

- [ ] **Step 5: Commit**

```bash
git add justfile evals/README.md
git commit -m "Add. eval recipes and docs for command-trace scoring"
```

---

### Task 12: First measured improvement — uniform area scoping

**Files:**
- Modify: `botmap/cli.py`, `botmap/data/skill.md`
- Modify: `tests/test_cli_schema.py`, `tests/test_cli_categories.py`

This is deliberately the **last** task. The harness must be able to measure the
change before the change ships, or there is no before-and-after — and this is
the first improvement to be scored on command-path correctness rather than on
error and download rates alone.

- [ ] **Step 1: Capture the baseline first**

Run the full train split on the current CLI and record it as round 05. Do not
skip this: without it, Task 12's effect is indistinguishable from the effect of
the new scoring itself.

Run:
```bash
just eval sonnet evals/questions.yaml
```
Expected: `report-5.md` + `proposals-5.json`, with `## Ranked path failures`
showing the `categories -t land_use` cluster.

- [ ] **Step 2: Extend `categories` to non-place types**

At `botmap/cli.py:975-990`, replace the two `UsageError` branches with real
enumeration: for types classified by `class`, aggregate `class` over the
resolved scope exactly as the existing code aggregates `categories.primary`.
Keep the field name in the output payload (`"field": "class"` vs
`"categories.primary"`) so an agent knows which key to filter on.

Preserve the existing scope contract unchanged — `--bbox` XOR `--in`, one
required, "global enumeration is too costly."

- [ ] **Step 3: Add `--in` / `--bbox` to `schema`**

At `botmap/cli.py:903`, add both options, resolving `--in` through the existing
`_resolve_in_place` (`cli.py:182`) so ambiguity warnings and parent-fallback
behave as they do everywhere else. Keep the Manhattan bbox at `cli.py:909` as
the default and say so in the help text; **do not make a scope required**, since
the field list is release-wide and area-independent.

Include the resolved bbox in the JSON payload so the example feature is
self-describing — an agent that sees `"bbox"` alongside `"example"` can tell
whether the sample is relevant to its question.

- [ ] **Step 4: Update the skill**

`botmap/data/skill.md` currently documents `categories` as place-only. Update
the schema cheatsheet and add a recipe for discovering `class` values, since the
skill is what the agent actually reads:
`botmap categories -t land_use --in "Brooklyn"`.

- [ ] **Step 5: Test**

Run:
```bash
uv run pytest tests/test_cli_schema.py tests/test_cli_categories.py -v
uv run pytest -m "not integration"
```
Expected: green, including a new test that `categories -t land_use --in X`
enumerates rather than raising.

- [ ] **Step 6: Re-run and compare**

Run the train split again and diff against the Step 1 baseline. The specific
prediction to check: `landuse-brooklyn` path-hit rate should rise, since the
agent's instinct was already correct and only the CLI refused it.

- [ ] **Step 7: Commit**

```bash
git add botmap/cli.py botmap/data/skill.md tests/
git commit -m "Add. area-scoped taxonomy verbs for every classified type"
```

---

## Verification

1. **Offline unit tests** — `just test` (excludes `integration`). Equivalence
   tables for `canon.py`, DSL matching for `expect.py`, normalization edge cases
   for `objective.py`. No network in any of them, matching the existing
   `tests/test_eval_*.py` convention.
2. **Backfill against the 40 existing runs** (Task 4, Step 3) — the two named
   assertions are the real acceptance test for the matcher, because both
   outcomes are independently documented in `progress_summary.md`.
3. **Judge stability** — 3 samples across 10 runs; read the disagreement rate
   before letting the judge carry 60% weight.
4. **End-to-end** — `just eval-smoke`, then a full train-split batch; confirm
   train and held-out are reported separately.
5. **Backend parity** — both agents over the same 10 questions, both `shim.log`s
   canonicalizing identically.
6. **Report continuity** — diff `report-example-05.md` against
   `report-example-03.md`: every section present in 03 must still be present, in
   the same order, with the new sections added rather than substituted.

## Success criteria

- `just eval` reports a weighted objective per question and per tier, with the
  held-out split broken out separately.
- Every tier 1–2 question is scored deterministically, with no LLM in the path.
- Re-scoring the 40 archived runs reproduces the two documented outcomes above.
- The minimal agent and headless Claude Code run from the same bank and produce
  directly comparable objectives.
- The report carries a `## Ranked path failures` section listing at least one
  exit-0 wrong command — the failure class the harness could not see before.
- `progress_summary.md` reads as one continuous series from round 01 to round
  05, with no metric silently redefined mid-table.

## Open risk

The judge carries 60% weight on tiers 3–5, roughly 40% of the bank. If Task 5
Step 2 shows poor self-agreement, the honest fallback is to report tiers 1–2
deterministically and treat 3–5 as qualitative. That still supports the central
claim, since tiers 1–2 are exactly where "did the agent pick the right verb on
the first try" is cleanest — and `path_first_try` is a deterministic measure of
precisely that.
