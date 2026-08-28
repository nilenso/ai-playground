# Round 1 — candidate set (revised for F9)

## How this round is judged

F9 established that completion rate cannot resolve a candidate on this suite:
seven questions sit at ceiling with no headroom, and the only three with
headroom flip between identical runs. So the old plan -- screen on a
mini-batch, read completion -- would produce a number that means nothing.

Judgement is therefore, in order of evidential weight:

1. **Deterministic mechanism check.** Does the change do what it claims, tested
   directly against the CLI with no agent involved? Zero noise, zero claude
   quota. This is the primary evidence that a candidate *works*.
2. **Regression on the seven ceiling questions.** Their mean command counts
   were *identical* across two independent baselines, so any perturbation is
   real signal rather than drift.
3. **In-situ trace reading on the target question.** Not a score. Did the agent
   actually encounter and use the new affordance? A mechanism that works but
   that the agent never reaches is a failed candidate.
4. **NOT completion rate on busstops / containing-point / hardware.** Those are
   the unstable three. Any movement there is reported as unproven.

A candidate that passes (1) but shows nothing in (3) is honest evidence that
the fix was in the wrong place -- which is a result worth having.

## Quota budget

Mechanism checks cost nothing (direct `botmap` calls, no `claude -p`) and can
run during a quota hold. Only steps 2 and 3 need quota. Ordered so the cheapest
decisive evidence comes first.

---

## Evidence this round is built on

**Cluster A -- silent zero** (busstops-coffee-williamsburg). Seven commands,
all exit 0, no errors, no answer. `count --where categories.primary=bus_stop`
returned 0 in Williamsburg AND 0 across all of Brooklyn, while `coffee_shop`
returned 58 and `train_station` returned 285. The agent proved the slug was
wrong; the tool never said so. It exhausted its budget on `categories --top
50`, then `--top 100`, then a wider area, then a synonym guess.

**Cluster B -- flag parity** (hardware-near-bikepaths-alameda). Two usage
errors in one run:

    count -t place   --category hardware_store   -> Usage: ... (exit 2)
    count -t segment --class    cycleway         -> Usage: ... (exit 2)

Both flags work on `places` / `roads`, and the agent used `--category` on
`places` successfully in the same run. The Skill's workflow says "Count before
pulling", so the documented first step rejects the flag the second step accepts.

---

## C1 -- near-match hint on `count` (TOOL, botmap/cli.py)

**Change.** When `count` yields 0 rows for a `--where categories.primary=X` or
`--class X` filter, emit the near-match suggestion `places` already produces.
Reuse the existing suggestion path; do not write a second one.

**Mechanism check (free, deterministic):**

    botmap --json count -t place --in "Brooklyn, US-NY" --where categories.primary=bus_stop
    expect: exit 0, count 0, AND a stderr hint naming bus_station
    control: same command with coffee_shop -> 1253, no hint

**Regression check:** the seven ceiling questions, especially
coffee-brooklyn-count (exercises `count`, mean 2.0 commands in both baselines).

**Falsified if:** the hint fires but busstops still shows the agent guessing
slugs -- meaning the agent never reads stderr on a zero result, and the fix
belongs somewhere it will be seen.

**Risk:** a hint on every legitimate zero is noise; a near-match worse than the
original is actively misleading.

## C2 -- fix the `bus_stop` slug (PROMPT, botmap/data/skill.md)

**Change.** Replace `bus_stop` with `bus_station` in the Skill's anti-pattern
line and the schema cheatsheet. Prior proposal #2 verified `bus_station` is the
real slug and returns real results.

**Mechanism check (free):** grep the installed SKILL.md for `bus_stop`; confirm
`botmap --json count -t place --in "Brooklyn, US-NY" --where
categories.primary=bus_station` returns non-zero.

**Deliberately competing with C1** on the same failure via the opposite lever.
Whichever shows movement says something about where effort pays -- which the
autoresearch README argues is worth more than either result alone.

**Falsified if:** busstops still fails, meaning the agent was not reading that
line anyway.

**Risk:** fixes one wrong example, not the class. Any other bad slug still
fails silently. If C2 shows movement and C1 does not, say plainly that the
narrower fix won -- do not dress it up as a general improvement.

**Only testable because F7 was fixed.**

## C3 -- `--category` / `--class` parity on `count` (TOOL, botmap/cli.py)

**Change.** Accept `--category X` on `count` as sugar for
`--where categories.primary=X`, and `--class X` for `--where class=X`, matching
`places` and `roads`. Reject supplying both spellings rather than silently
preferring one.

**Mechanism check (free, and the most decisive in the round):**

    count -t place   --category hardware_store   -> exit 0 (currently exit 2)
    count -t segment --class    cycleway         -> exit 0 (currently exit 2)
    equivalence: --category X must return the same count as
                 --where categories.primary=X
    conflict:    --category X --where categories.primary=Y -> clean error, not silent

**Regression check:** ceiling questions; `count` is used by several.

**Falsified if:** the flags work but hardware's command count does not fall --
the recovery was already cheap, so a fix that saves nothing is added surface
area for no gain.

**Risk:** `-t segment --class` must map to the right column or it silently
returns zero -- the exact failure C1 exists to prevent. The equivalence check
above exists to catch that.

---

## Mini-batch (revised)

Old batch optimised for completion signal, which F9 killed. New batch is
weighted toward stable regression detectors:

| question | role | mean cmds (both baselines) |
|---|---|---|
| coffee-brooklyn-count | regression, exercises `count` | 2.0 / 2.0 |
| where-boston | regression, control | 1.0 / 1.0 |
| tall-buildings-manhattan | regression, control | 3.0 / 3.0 |
| busstops-coffee-williamsburg | in-situ trace for C1/C2 | 3.5 / 7.0 (unstable) |
| hardware-near-bikepaths-alameda | in-situ trace for C3 | 6.5 / 7.0 (unstable) |

The first three have *identical* command counts across two baselines, so a
change there is real. The last two are read as traces, not scores.
