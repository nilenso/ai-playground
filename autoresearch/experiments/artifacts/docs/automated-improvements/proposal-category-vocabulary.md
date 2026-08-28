# Proposal: teach the Skill to translate category vocabulary

- **Target:** `skill` (`botmap/data/skill.md`)
- **Status:** untested — not applied
- **Raised:** 2026-08-13, from tier2 eval findings + manual category probing

## Problem

`categories.primary` is a fixed Overture taxonomy in American English
snake_case. Users ask in their own words. When the agent passes the user's
phrase through verbatim, the query returns zero rows and the agent reports
"none found" — a wrong answer that looks like a successful run.

Nothing in the current system catches this:

- The Skill never mentions that category values are a controlled vocabulary.
- The CLI's `Did you mean:` hint (`cli.py:97-149`) matches on shared tokens,
  substrings, and spelling distance. Synonyms share none of those.

Measured, on the CLI's own scoring rules:

| Input | CLI suggestion |
|---|---|
| `petrol_pumps` | *(nothing)* |
| `petrol_pump` | *(nothing)* |
| `bus_station` | `bus_station`, `gas_station`, `fuel_station` |

Character-level cosine similarity was considered as a fix and rejected on
evidence — it scores every true synonym at exactly 0.000, identical to
unrelated pairs, so no threshold separates them:

| Pair | cosine (char-3) | difflib |
|---|---|---|
| `petrol_pumps` ~ `gas_station` | 0.000 | 0.174 |
| `chemist` ~ `pharmacy` | 0.000 | 0.133 |
| `takeaway` ~ `fast_food` | 0.000 | 0.118 |
| `petrol_pumps` ~ `parking` (control) | 0.000 | 0.211 |

The signal is semantic, not lexical. The agent already has that knowledge —
it just is not told to apply it before querying. That makes this a Skill
change, not a CLI change: zero runtime cost, no new dependency, nothing to
maintain as the taxonomy grows.

## Evidence from real data

Verified against live `botmap categories` output (Cambridge US-MA and
Luxembourg, top 400 each):

- `gas_station` exists; `petrol_station`, `fuel_station`, `petrol` do not.
- `cinema` exists; `movie_theater` does not.
- `fast_food_restaurant` exists; `fast_food` does not.
- `tattoo_and_piercing` exists — this is the value behind the eval question
  `category-tattoo-near-me`.
- `pharmacy` exists in both; `drugstore` only in Luxembourg — vocabulary is
  region-dependent, so the Skill must teach lookup, not just a fixed table.

## Proposed change

Insert after step 5 of "Troubleshooting flow", and add a pointer from step 4
(`… or check categories/schema for the right value` → `… — see **Category
vocabulary** below before concluding a place has none.`).

````markdown
## Category vocabulary — translate before you query

`categories.primary` is a fixed Overture taxonomy: American English,
snake_case. **The user's words are usually not the taxonomy's words.** Map
them yourself before querying — never pass the user's phrase through
verbatim.

| User says | Overture value |
|---|---|
| petrol pump, petrol station | `gas_station` |
| tattoo parlor, tattoo shop | `tattoo_and_piercing` |
| takeaway, fast food | `fast_food_restaurant` |
| chemist | `pharmacy` (also `drugstore` in some regions) |
| movie theater | `cinema` |
| EV charger | `ev_charging_station` |

Rules:

- **Zero rows from a `--category` filter almost always means the wrong
  value, not an empty area.** Re-check the vocabulary before reporting
  "none found" — that is the single most common way to answer wrongly.
- **The CLI's `Did you mean:` hint cannot catch synonyms.** It matches on
  shared words, substrings, and spelling distance only, so
  `bus_station` → `bus_stop` works but `petrol_pump` → `gas_station`
  scores zero and prints nothing. Silence is not confirmation.
- **When unsure, look it up instead of guessing:**
  `botmap --json categories -t place --in "<place>" --top 200`
  lists the values that actually exist there, with counts.
- **Vocabulary varies by region.** Confirm in the target area rather than
  assuming a value seen elsewhere.
````

## Hypothesis

Agents given colloquial category words will translate them before querying,
instead of returning zero rows and reporting the feature absent.

## How to test

The eval installs the packaged Skill verbatim (`runner.py:57-60`,
`packaged_skill_text()`), so there is no variant mechanism today. A/B means:

1. **Baseline.** Run a bank of colloquial-vocabulary questions against the
   Skill as-is. Record completion, error rate, avg commands, cost.
2. **Treatment.** Apply the patch above to `botmap/data/skill.md`, re-run the
   same bank with the same model and repeat count.
3. **Compare** the two reports.

The current banks barely exercise this: only `category-tattoo-near-me` uses a
colloquial term, and it fails for an unrelated reason (no location). Testing
this needs new questions phrased the way users actually speak — e.g. "how
many petrol pumps in Cambridge MA", "find a chemist near <point>", "how many
takeaways in Luxembourg" — each with a known-correct answer obtainable via
the real category value.

## Keep / throw criteria

- **Keep** if zero-row-then-give-up outcomes drop on the colloquial bank
  without raising avg commands or cost elsewhere.
- **Throw** if completion is unchanged (the Skill is already long; a section
  that earns nothing is a net cost to every prompt), or if agents start
  running `categories` defensively on questions that never needed it.

## Notes

- A per-run `--skill` flag on the runner would make this and future Skill
  proposals testable without mutating the packaged file. Not proposed here.
- Related and separate: `skill.md` asserts bus stops are `place` categories
  in three spots. `bus_stop` does not appear in the top 400 categories for
  either Cambridge or Luxembourg, while `bus_station` does. Report 4's
  proposal #3 says the same. Worth its own proposal.
