# Generate the botmap agent-usability question bank

You have the `botmap` CLI installed. Your job is to produce an eval question
bank at `questions.yaml` that measures how well an LLM agent uses this CLI.

Work in two phases. Do not skip Phase 1. Every fact in the output must come
from a command you actually ran — not from your knowledge of Overture Maps.
Your training data is stale relative to the current release, and this CLI's
flags are not the ones you may have seen elsewhere.

---

## Phase 1 — Probe

Run these and keep the raw output. Write it to `probe.log` as you go.

**Surface**
```
botmap capabilities
botmap types
botmap themes
```
For every subcommand in `capabilities`, run `botmap <cmd> --help`. Record for
each: required flags, optional flags, which flags are mutually exclusive, and
which accept a place name vs a bbox vs only one of the two. That last
distinction is the source of most agent failure, so be exhaustive about it.

**Vocabulary**
```
botmap categories
```
Capture the actual category values. You will need exact strings for every
filter in the bank. Note the field they belong to and whether the CLI exposes
any alternative category field.

**Schema**
```
botmap schema <type>
```
for every type in `botmap types`. Record real field paths and note which fields
are commonly null in the sample.

**`--where` dialect**
Determine empirically what expression language `--where` accepts. Try an
equality filter, a substring/LIKE filter, a numeric comparison, and a nested
field path. Record which succeed. Then run one deliberately malformed clause
and one clause referencing a nonexistent field, and record whether they error
or silently return zero. That behaviour decides several cases below.

**Places**
For every place name you intend to use, run `botmap where "<name>"`. Discard
any that don't resolve. Record what an ambiguous name actually returns —
candidate list, error, or first match — since you cannot write the ambiguity
case without knowing.

**Size**
Run `botmap count -t <type> --in <place>` for every (type, place) pair you plan
to use. Record real counts. You need these to pick places small enough that a
badly-behaved agent still finishes the run.

---

## Phase 2 — Verify premises, then write

Several question types depend on claims about the data. **Test each claim
before writing a question that assumes it.** If a probe contradicts the claim,
drop the question rather than writing around it — a case built on a false
premise trains the eval against correct behaviour.

Claims to test, each with the command that settles it:

| Claim | How to settle it |
|---|---|
| Some category is absent from `place` and lives in another type | count it in `place`, then in the suspected type |
| A feature kind appears in two types with different counts | count in both, compare |
| A convenience verb covers more than its name suggests | try the broader filter through that verb |
| A field exists but is mostly null | `schema`, then `sample` and inspect fill |
| Some ask has no supporting field at all | search `schema` output for it across types |
| A type has no convenience verb | check `capabilities` — this drives `download_is_legitimate` |

Then write the bank.

### Output format

```yaml
# Agent-usability eval question bank.
# Fields:
#   id                     stable slug (no '__' — that delimits run dirs)
#   question               the prompt handed verbatim to `claude -p`
#   tier                   1..5 complexity tier
#   download_is_legitimate true only when no convenience verb covers the type
#   target_type            expected Overture type(s) for the answer
#   place                  optional; resolved by the cost guard to bound query size
#   notes                  ideal path (and, for compound, the expected decomposition)
#   subtasks               optional; expected verb-by-verb decomposition (compound)
```

### Tiers

- **1** — one verb, one answer. Only tests whether the agent picks the right
  verb first try. 5 cases.
- **2** — right verb exists but isn't the obvious one, or the filter needs
  something the model can't guess. 7 cases.
- **3** — malformed, ambiguous, or aimed past the data. Success is a good
  refusal or redirect, not a good answer. 6 cases.
- **4** — multi-verb; needs a plan before the first call. Usually an external
  tool for any join. 5 cases.
- **5** — compound; the decomposition itself is the thing under test. 7 cases.

### Rules for questions

**Every question is something a person wants from the map.** Tool knowledge is
an obstacle in the path, never the destination. Reject any question that could
be answered by reading the README:

- ✗ "What kinds of features can I query?"
- ✗ "What fields does a place have?"
- ✗ "Is this GERS ID still valid?"
- ✓ "How many hospitals are in Rhode Island?"
- ✓ "I need a clipping polygon for Brooklyn to use in QGIS."

If discovery is required, bury it mid-task: ask for tattoo parlors so the agent
must look up the category, rather than asking what the category is.

**Phrase questions the way a user would**, not the way the CLI accepts them. No
flag names, no type names, no Overture jargon in the `question` field. The gap
between user phrasing and CLI vocabulary is a large part of what's under test.

**Write exact syntax in `notes`.** Include the real flags from Phase 1, real
category strings, real field paths. `count --category X` is wrong if `count`
has no `--category`; write what the CLI actually takes.

**Name the failure mode in every `notes`.** Not just the ideal path — the
specific wrong thing an agent will plausibly do. Prefer failure modes that
produce a confident, well-formed, wrong answer over ones that crash. Silent
wrongness is what this eval is for.

**Set `download_is_legitimate: true`** wherever no convenience verb covers the
target type. Include at least two such cases at tier 5 with an explicit note
that penalising `download` there would be a false positive. Without them the
eval teaches that `download` is always wrong.

**Bound cost.** Use the Phase 1 counts. Prefer small countries and single
cities. If you want a case where the correct behaviour is *refusing* because
the result is too large, pick a place you have verified is genuinely too large.

**Tier 3 needs machine-actionable error expectations.** For each, state what a
good error contains: the specific unsupported thing named, a suggested
alternative, and enough structure for a one-command retry. If the CLI's actual
error text falls short, note the gap — that is a finding, not a reason to skip
the case.

---

## Deliverables

1. `questions-newset.yaml` — the bank, 30 cases across the tier distribution above.
2. `probe.log` — raw Phase 1 output.
3. `findings.md` — short. Every place where the CLI's actual behaviour differs
   from what an agent would reasonably expect: missing flags on some verbs that
   exist on others, verbs that take `--in` vs ones that only take `--bbox`,
   filters that silently return zero instead of erroring, deprecated fields
   still exposed. These are CLI bugs surfaced by writing the eval, and they are
   often more valuable than the bank itself.

Validate the YAML parses before finishing. Report the tier distribution and the
`download_is_legitimate` count.
