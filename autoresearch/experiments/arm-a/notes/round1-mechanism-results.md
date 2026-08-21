# Round 1 — mechanism check results (zero quota spent)

All checks are direct `botmap` CLI calls. No `claude -p`, no subscription or
OpenRouter spend. Run 2026-08-21 against release 2026-08-19.0.

## C1 — near-match hint on `count`  (branch cand/count-zero-hint)

| check | result |
|---|---|
| hint fires on `bus_stop` | PASS — `Did you mean: bus_station, bus_tours, party_bus_rental?` |
| `bus_station` ranked first | PASS — the exact slug the failing run never found |
| control: valid `coffee_shop` (1253) does not hint | PASS |
| regression: `places` still hints after the refactor | PASS |

The hint names the right answer first. In the baseline trace the agent ran
seven commands hunting for it and never got there.

## C2 — `bus_stop` -> `bus_station` in skill.md  (branch cand/skill-bus-station)

| check | result |
|---|---|
| no `bus_stop` left in skill.md | PASS — 3 edits: recipe 15, cheatsheet, anti-pattern |
| installed skill resolves to the repo file | PASS (editable install) |
| `bus_station` returns real data in Williamsburg | PASS — count 3 (vs 0 for `bus_stop`) |
| `coffee_shop` half still works | PASS — count 58 |

Recipe 15 of the Skill is almost verbatim the eval question ("Bus stops ...
Williamsburg") and taught a category that has never existed.

## C3 — `--category` / `--class` parity on `count`  (branch cand/count-flag-parity)

| check | baseline | candidate |
|---|---|---|
| `count -t place --category hardware_store` | exit 2 (Usage) | exit 0, count 414 |
| `count -t segment --class cycleway` | exit 2 (Usage) | exit 0, count 506 |
| equivalence vs `--where categories.primary=` | — | 414 == 414 PASS |
| equivalence vs `--where class=` | — | 506 == 506 PASS |
| conflicting spellings | — | exit 2, "are the same filter; use one or the other" |

The equivalence check was the point: a `--class` mapped to the wrong column
would have returned a silent zero, which is the failure C1 exists to prevent.

## Status

All three mechanisms verified. None discarded. Nothing has yet been measured
with an agent -- that needs quota and is on hold.

Reminder from F11: C1 must NOT be judged on `cli_error_count`. Adding the hint
converts a silently-clean call into a `bad_category_value` error, so the scorer
will record C1 as strictly worse for making the tool strictly better.
