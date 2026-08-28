# Command-Trace Scoring for the Agent-Usability Eval — Design

**Date:** 2026-08-13
**Status:** Draft — pending approval

## Problem

The Overture CLI was redesigned around a thesis (see
`designing_cli_interfaces_for_data_products.md`): expose *question-shaped*
verbs and treat `download` as an escape hatch. The v1 eval
(`docs/superpowers/specs/2026-05-28-agent-usability-eval-design.md`) measured
whether agents avoid `download` and avoid CLI errors, and four improvement
rounds have run against it — download rate 35% → 15%, average commands per run
−22% (`docs/automated-improvements/progress_summary.md`).

That v1 deliberately deferred one thing. Its scope section reads: *"process
signals only… No answer-correctness judging in v1; the final answer text is
recorded so correctness can be layered in later without re-running."*

The correctness worth layering in is **not** answer correctness. What the CLI
redesign claims is that an agent can get from a natural-language question to
the right command. So the thing to measure is the command, not the number it
returns. That choice also sidesteps the maintenance trap of answer keys:
Overture ships a release roughly monthly, and `count -t place --in Brooklyn
--where categories.primary=coffee_shop` returned 1,255 on `2026-07-22.0` and
will return something else next release.

Today nothing measures it. `evals/score.py:41` defines `completed` as "the
stream-json `result` event was non-error and non-empty," so a confidently wrong
command that exits 0 and prints a plausible number scores exactly as well as
the ideal one. This is the failure `evals/prompt.md:136` names as the point of
the whole exercise — *"Silent wrongness is what this eval is for"* — and it is
the one failure the harness cannot currently see. Two fields that already
encode the right answer, `target_type` and `subtasks` (18 questions), are read
by no code at all.

This design adds a third failure mode to the two the eval already surfaces:

3. **Wrong command, clean exit** — the agent ran a command that succeeded but
   could not answer the question: the wrong verb, the wrong filter field, the
   right filter against the wrong type. Signals a vocabulary failure: the CLI
   accepted something that looked right and was not.

## Scope and key decisions

- **Ground truth:** the command trace, captured by the existing PATH shim. No
  expected answers, no pinned release, no numeric tolerances.
- **Scoring:** hybrid. A deterministic canonical-form matcher covers tiers 1–2,
  where a small set of accepted commands exists. An LLM judge covers tiers 3–5,
  where success is a good refusal (T3) or a decomposition with many valid
  orderings (T4–5).
- **Equivalence lives in one place.** `places --category coffee_shop` and
  `places --where categories.primary=coffee_shop` are both correct. Rather than
  enumerating phrasings per question, argv is lowered into a canonical form and
  the equivalence rules live in that single module. A newly accepted phrasing
  is then a one-line change, not an edit across 100 YAML entries.
- **Objective:** correctness 60%, token efficiency 20%, wall-clock 20%.
  Efficiency terms are normalized **per question**, since a tier-5 compound
  question legitimately costs 4–10× a tier-1 lookup.
- **Held-out split:** 80/20 train/test. Proposals are generated from train
  only; the report shows the held-out delta.
- **Data backend:** live Overture S3, serial runner, as in v1. Wall-clock is
  20% of the objective, so parallel S3 contention would corrupt the measurement
  it is meant to feed.
- **Agent harness:** two arms — headless `claude -p` with the bundled Skill
  (the intended deployment, unchanged from v1) and a new minimal agent (one
  bash tool, short prompt) as the baseline.
- **Scale:** 100 questions × 2 repeats = 200 runs. At the measured mean of
  $0.25 and 103s per run (p90 255s), that is ≈$50 and ≈5.7h serial per
  iteration.

Out of scope: answer-correctness scoring, replay/record caching of CLI
responses, runner parallelism, multi-model comparison, CI integration,
auto-applied patches.

## CLI design goal: every taxonomy verb is area-scoped

**Every verb that derives vocabulary from the data takes `--in` / `--bbox`, on
the same contract `categories` uses today.** This is a goal of the work, not a
consequence of it — the eval exists partly to measure whether it holds.

The rule matters because taxonomy verbs are how an agent *learns the strings it
must filter on*. If asking "what values exist here?" is spelled differently for
each type, the discovery step becomes the thing the agent gets wrong, and every
downstream filter inherits the error.

Current state:

| Verb | Area-scoped | Gap |
|---|---|---|
| `categories` (`cli.py:969`) | yes — `--bbox` XOR `--in`, one required | **`place` only**; hard-errors for every other type |
| `schema` (`cli.py:903`) | **no** | hardcodes a Manhattan bbox at `cli.py:909` |
| `types`, `themes` | n/a | static catalogs; no data read, so scoping is meaningless |

Three changes follow:

1. **`categories` covers non-place types.** For types classified by `class`
   rather than `categories.primary`, enumerate `class` over the same scope.
   Today it raises a `UsageError` pointing at `schema` instead. This is
   proposal **P4 from report-03, the one actionable proposal never
   implemented**, and it is the root of the longest-standing per-question
   failure in the suite: `progress_summary.md` records that on
   `landuse-brooklyn`, "agents trying `categories -t land_use` to discover
   class values is exactly the right behavior — the error is the CLI refusing
   them."

2. **`schema` takes `--in` / `--bbox`.** The field *list* is release-wide and
   area-independent, but the `example` feature and any observed-null-fill
   signal are not — and today they always come from Manhattan. An agent asking
   about water in the Lake District gets a Manhattan example and reasons from
   it. Keep the current bbox as the documented default so `schema -t place`
   stays fast and flag-free, but let it be overridden.

3. **`categories` gains `--search`.** `evals/findings.md` §10: there is no way
   to ask which categories match *tattoo*; the only route is `--top 400 | grep`,
   and `--top` is a guess. If the slug ranks below N the grep returns nothing
   and the agent concludes the category does not exist — reintroducing, one
   layer up, the exact silent failure the near-match hint was built to prevent.
   Area-scoped like the rest, and answerable locally from
   `evals/overture_categories.csv`.

### Why this is the highest-leverage surface

`evals/findings.md` §6 rates the taxonomy the *"single most likely source of a
silently wrong number,"* and the mechanism is a discovery failure, not a query
failure. `categories.primary` stores only the **leaf** of a 6-level tree.
`asian_restaurant` is an interior node with a 55-category subtree, so the
obvious query undercounts by ~10× with no error and no hint:

| filter | Cambridge MA |
|---|---|
| `categories.primary=asian_restaurant` | **23** |
| union of 9 hand-listed cuisine leaves | **224** |
| `taxonomy.hierarchy=asian_restaurant` (the correct query) | traceback, exit 1 |

The ancestry *is* in the data — `taxonomy.hierarchy` is populated on every
categorised row and matches the published sheet — but it is a list field, so
filtering on it dies with the raw PyArrow traceback of §4. The CLI ships the
hierarchy and then makes it unusable.

This bounds what area scoping alone can buy. A uniform `--in`/`--bbox` contract
makes the taxonomy *reachable*; it does not make it *correct*. `findings.md`
ranks **§4+§6 together** — teach `--where` list membership — as the second
priority overall, and that change is what turns `categories --in X` from an
enumeration into a usable rollup. Treat the two as one goal, sequenced: scope
first, then list-membership filtering.

Two further items belong to the same surface and are noted here so they are not
rediscovered: `basic_category` is ~94% filled, undocumented in the Skill, and
does **not** interchange with `categories.primary` (`basic_category=pharmacy`
returns 0; the value is `pharmacy_and_drug_store`). And the release removed 51
categories with a documented redirect column that the CLI never surfaces — a
silent zero for any agent whose training data predates it.

Unlike `categories`, `schema` must **not** require a scope: its primary output
is the field list, which needs no area. The shared contract is "accepts
`--in`/`--bbox` and means the same thing by them," not "requires them."

This goal is measurable by the harness rather than asserted: `canon.py` lowers
`--in`/`--bbox` into `CanonCall.scope` uniformly across every verb, so a
question whose expected path includes a scoped taxonomy call is scored the same
way as any data call. Tier-2 questions that require discovering a `class` value
before filtering on it are the direct test.

## Architecture

Four new modules under `evals/`, plus a second agent backend. Two of them are
pure and fixture-tested, matching the existing `trace.py` / `taxonomy.py`
convention; the two LLM-touching ones run post-hoc over stored artifacts, so
they re-run without touching S3.

```
evals/
  canon.py          # argv -> CanonCall (pure)
  expect.py         # expectation DSL + matcher -> PathScore (pure)
  judge.py          # LLM judge for tiers 3-5, 3-sample median
  objective.py      # weighted 60/20/20, per-question normalization (pure)
  reference.json    # generated; best-observed tokens/duration per question
  agents/minimal.py # minimal agent backend
```

### 1. Canonicalizer (`evals/canon.py`)

Turns one `ShimCall.argv` into a comparable value by parsing it with the **real
Click command objects**, so aliases (`-t`/`--type`), flag order, and the
group-level no-op `--json` collapse without a hand-written parser:

```python
ctx = click.Context(cli)
_, rest, _ = cli.make_parser(ctx).parse_args(argv)
cmd = cli.get_command(ctx, rest[0])
sub = click.Context(cmd, parent=ctx); cmd.parse_args(sub, rest[1:])
explicit = {k: v for k, v in sub.params.items()
            if sub.get_parameter_source(k) is not ParameterSource.DEFAULT}
```

The `ParameterSource` filter is load-bearing: without it every call carries
`release='2026-07-22.0'` and `output_format='geojsonseq'`, and nothing compares
equal.

```python
@dataclass(frozen=True)
class CanonCall:
    verb: str          # 'count' | 'places' | 'download' | 'where' | ...
    intent: str        # count | fetch | inspect | resolve | meta
    type: str | None   # lowered from the verb, or read from -t
    scope: tuple       # ('in', 'brooklyn') | ('bbox', ...) | ('point', lat, lon)
    filters: frozenset # {('categories.primary', '=', 'coffee_shop')}
    raw_place: str | None
    malformed: str | None
```

Lowering rules — these *are* the equivalence classes:

- verb → type by inverting `botmap/cli.py:310 TYPE_TO_VERB`.
- `--category X` → `('categories.primary','=',X)`; `--class X` → `('class','=',X)`;
  `--street`/`--number`/`--postcode` → their field filters.
- `--where` parsed with `botmap/filters.py:105 parse_where_expr`, which already
  produces the `(key, op, value)` shape that `count --json` emits.
- Place names casefolded and compared on the first comma-segment, so
  `Manhattan, US-NY`, `Manhattan, NY` and `Manhattan` unify. A deliberate
  simplification; the raw string is retained for the report.
- A command missing a required parameter (e.g. `download` with no `-f`) yields
  `malformed=<reason>` rather than being dropped — a malformed call is a
  finding, not noise.

Reusing `TYPE_TO_VERB` and `parse_where_expr` rather than restating them is a
correctness requirement, not a convenience: `botmap/cli.py:321
_suggest_verb_command` performs the `--category` rewrite in the reverse
direction, and if the two definitions drift the eval silently starts grading
against a CLI that no longer exists.

### 2. Expectations (`evals/expect.py`)

A new optional `expect:` block per question. Absent → no path score, so the
100-question bank backfills incrementally rather than in one commit.

```yaml
expect:
  accept:                          # any one match => full credit (T1-2)
    - {intent: count, type: place, scope: {in: brooklyn},
       filters: ["categories.primary=coffee_shop"]}
  forbid:                          # any match => violation (all tiers)
    - {verb: download}
  allow_extra: [where, schema, categories]   # discovery, uncharged
```

`require_all` replaces `accept` for tiers 4–5: every listed form must appear,
order-free, scoring `matched / len(require_all)`. This is where the currently
dead `subtasks` field becomes checkable. Tier 3 uses `forbid` alone
(`{intent: fetch}`), since success there is a refusal.

A form matches when every key it *specifies* matches; unspecified keys are
wildcards, and `filters` matches as a subset — so a question can require a
category filter without caring that the agent also passed a bbox.

Emitted per run: `path_hit`, `path_first_try`, `path_violations`,
`path_coverage`, `path_wasted`. **`path_first_try`** — the first
non-discovery call matched an accepted form — is the sharpest signal in the
harness: it separates "found it" from "groped until something worked," which
`command_count` only hints at.

### 3. Judge (`evals/judge.py`)

Runs over stored artifacts, never during a run. Input: the question, `notes`
(which already names both the ideal path *and* the plausible failure mode for
all 64 existing entries), `subtasks`, the canonicalized trace, `final_answer`,
and CLI stderr. Output is structured:

```json
{"path_grade": 0, "named_the_unsupported_thing": true,
 "offered_a_retryable_alternative": true, "rationale": "..."}
```

Three samples, median taken, **and the inter-sample disagreement rate reported**
— a judge that does not agree with itself cannot carry 60% of the objective.
The LLM call follows the existing `synthesize.py` convention so there is one
way to invoke a model in this harness.

### 4. Objective (`evals/objective.py`)

- correctness 60% — deterministic `path_hit` / `path_coverage` for tiers 1–2
  and for the `forbid` half of 3–5; judge `path_grade` for the rest.
- token efficiency 20%, wall-clock 20% — `min(1, ref/actual)` with `ref` the
  best value yet observed for **that question**, persisted in `reference.json`.

Per-question normalization is not incidental. Fleet-wide normalization would
let tier-5 questions dominate both efficiency terms and swamp correctness.
`reference.json` is a ratchet — it only improves — so efficiency scores are
comparable across iterations but not absolute, and the report must say so.

### 5. Minimal agent (`evals/agents/minimal.py`)

An observe/act loop over the Messages API: one `bash` tool, a short system
prompt, the same temp workdir and the same PATH shim — so `shim.log` is
identical in shape and every downstream module works on it unchanged.
`evals/trace.py:88` currently reads usage from the stream-json `result` event
and is Claude-Code-specific; the runner kind is written into the run dir and
usage parsing dispatches on it, rather than forcing the minimal agent to fake a
stream-json envelope.

## Data flow

```
questions.yaml ─┐
                ├─> runner.py ──> runs/<bank>/<id>__r<n>/{transcript, shim.log}
shim + cache ───┘                     │
                                      v
                          canon.py + expect.py
                                      │
                                      v
                    score.py ──> runs/.../record.json  (+ path fields)
                                      │
                        judge.py ─────┤   (tiers 3-5, post-hoc)
                                      v
                              objective.py
                                      │
                                      v
                    synthesize.py ──> report-N.md + proposals-N.json
```

## Error handling

- **Un-backfilled questions** (no `expect` block) write `None` for every path
  field, never `0`. A missing expectation must never read as a failed one.
- **Unparseable argv** is retained as `CanonCall(malformed=...)` and surfaces in
  the report; it is never silently discarded.
- **Judge disagreement** above a stated threshold demotes tiers 3–5 to
  qualitative reporting rather than letting an unstable grade carry 60% weight.
- **Run-dir collisions.** `evals/runner.py:89` writes `runs/<id>__r<n>`, which
  is bank-agnostic, while `questions-tier6.yaml` reuses ids from
  `questions-tier1..5.yaml`. `evals/score.py:135` will score a stale run
  against a new bank's flags. Run dirs become `runs/<bank>/<id>__r<n>/`.
- **Cost guard, cache warm, shim fail-open** behave as in v1, unchanged.

## Testing strategy

- `canon.py` is table-driven off a fixture of equivalence and non-equivalence
  pairs — deterministic, no network. The non-equivalence table matters as much
  as the equivalence one: a canonicalizer that collapses `count` and `places`,
  or `place` and `building`, would score everything as correct.
- `expect.py` and `objective.py` are unit-tested against synthetic traces.
- The matcher's real acceptance test is **re-scoring the 40 archived runs**,
  where two outcomes are independently documented in `progress_summary.md`:
  `tall-buildings-manhattan__r1` should show `path_hit` and `path_first_try`
  true; `busstops-coffee-williamsburg` should show a non-empty
  `path_violations` for its `download -t infrastructure` fallback.
- `judge.py` and the minimal agent are exercised by a live smoke run, not unit
  tests, as with the v1 runner and synthesizer.

## Success criteria

- `just eval` reports a weighted objective per question and per tier, with the
  held-out split broken out separately.
- Every tier 1–2 question is scored with no LLM in the path.
- Re-scoring the 40 archived runs reproduces both documented outcomes above.
- The report carries a `## Ranked path failures` section listing at least one
  exit-0 wrong command — the failure class the harness could not previously see.
- Both agent backends run from the same bank and produce directly comparable
  objectives.
- Every taxonomy verb that reads data accepts `--in`/`--bbox` and lowers to the
  same `CanonCall.scope`, and `categories` enumerates a classifying field for
  every type that has one.
