# CLI findings surfaced while writing the eval bank

Everything below was measured against `botmap 0.1.2`, Overture release
`2026-07-22.0`, during the Phase 1 probe. Raw output is in `probe.log`.

These are places where the CLI's actual behaviour differs from what an agent
would reasonably expect after reading the bundled Skill or the `--help` text.
Ranked by how likely they are to produce a **confident, well-formed, wrong
answer** rather than a crash.

---

## 1. The division-geometry verbs take ~20 minutes and emit nothing while they work

Severity: **critical** — three documented verbs are indistinguishable from hung.

```
$ botmap where "Monaco" --geometry           # exit 0 after 1181.5s (19m 42s), valid MultiPolygon
$ botmap --json containing 42.3736,-71.1097  # exit 0 after  637.2s (10m 37s), correct divisions
$ botmap boundary "Monaco"                   # no output at 120s
$ botmap boundary "Cambridge, MA"            # no output at  60s
```

Both timed commands **do** eventually succeed and return correct results —
44KB of valid GeoJSON, and the right division stack (Middlesex County →
Massachusetts → …). So this is extreme latency, not a deadlock, and `boundary`
is almost certainly the same path. Nothing is broken; everything is unusable.

The operational effect is the same as a hang: no stdout, no stderr, no progress
indication, no timeout of their own, for ten to twenty minutes. The only output
ever produced during the wait was the unrelated `--in` ambiguity warning. An
agent has no way to distinguish this from a wedged process, and will either
block for the whole run or kill a command that was about to work.

By contrast `botmap at 42.3736,-71.1097 -t place -n 3` returns in **6.6s**, so
this is not general S3 slowness — it is specific to the code paths that read
`division_area` geometry.

This matters more than a normal perf bug because:

- Skill **recipe 8** (`containing`) and **recipe 16** (`where … --geometry`)
  advertise these as the supported paths, so an agent will reach for them
  first.
- The `no_match` error message *also* recommends `containing LAT,LON` as a
  recovery route, so a place-resolution failure funnels the agent straight
  into a hang.
- With no output at all, an agent cannot distinguish "slow" from "wedged" and
  will typically block until the harness kills the run.

Suggested fix, in order of value: emit a progress line on stderr so the command
is distinguishable from a hang; investigate why the division-geometry scan is
~200x slower than `at` (STAC pruning may not be applied on this path); and add
a default request timeout so it fails loudly rather than silently. Documenting
the expected runtime is the minimum.

---

## 2. The Skill's `bus_stop` example uses a slug that does not exist

Severity: **medium** — a one-word doc bug, not the design error I first called it.

The Skill states, in the anti-patterns section:

> **Bus stops and transit points are `place` features.** Use
> `places --category bus_stop` (also bus_station, train_station) — not
> `download -t infrastructure`.

**The guidance is correct; only the example slug is wrong.** "Bus stop" is
ordinary regional vocabulary — across Indian, British and much other English it
is exactly what Overture names `bus_station` — so directing agents at `place`
for this question is right. `bus_station` (L3, travel_and_transportation >
ground_transport_facility_or_service > public_transit_facility_or_service) is a
real category and returns real results:

```
Go Bus Boston · MBTA - Alewife Station · Harvard Square Upper Busway ·
MBTA Charlestown Bus Garage · Davis Square Busway · Wellington Station   (12 total)
```

The defect is narrow: **`bus_stop` is not a slug.** It appears nowhere in the
published place taxonomy at any level, and nowhere in the `Old Primary Category`
column either, so it was never renamed or deprecated — it simply never existed.
`places --category bus_stop` therefore returns 0 with no near-match hint, and an
agent copying the Skill verbatim reports that Cambridge has no bus stops.

Fix: change `bus_stop` to `bus_station` in the Skill's anti-pattern line and in
the schema cheatsheet's category list. Optionally add `bus_stop` →
`bus_station` to the near-match hint's alias table, since it is what users will
type.

### Correction to an earlier version of this document

I first reported that bus stops "live in `infrastructure` as class=bus_stop"
with 650 records in Cambridge, and called the Skill inverted. That was wrong on
the framing and unreliable on the evidence:

- The framing ignored that "bus stop" and "bus station" are the same ask in most
  varieties of English. `place`/`bus_station` is the right answer to the user's
  question.
- The evidence did not hold up the way I described it. `download -t
  infrastructure --where class=bus_stop` does not return 0 rows — it is
  **hard-refused by a guard in the CLI** that asserts the same false premise as
  the Skill, and redirects to `places --category bus_stop`, which is empty. See
  #13; that shared premise is the real bug, and it is worse than the doc typo.

`infrastructure` does contain roadside waypoints at a finer granularity
(`Faneuil St @ Hobart St`), which are genuinely different objects from the 12
named terminals and busways in `place`. But that is a data-modelling nuance, not
a reason to send users away from `places`.

---

## 3. The zero-result near-match hint exists on `places` but not on `count` or `sample`

Severity: **high** — the documented workflow routes agents onto the silent path.

The hint added for trace D works well:

```
$ botmap places --bbox … --category ferry_terminal
[botmap] 0 rows. categories.primary='ferry_terminal' is not present in this bbox.
         Run `botmap categories -t place --bbox …` to see what's available.

$ botmap places --bbox … --where categories.primary=zzz_not_real
[botmap] 0 rows. No place has categories.primary='zzz_not_real' in this bbox.
         Did you mean: commercial_real_estate, real_estate, real_estate_agent? …
```

But it does not fire anywhere else:

| command | wrong category value | hint? |
|---|---|---|
| `places --category X` | 0 rows | ✅ |
| `places --where categories.primary=X` | 0 rows | ✅ |
| `count --where categories.primary=X` | `{"count": 0}`, exit 0 | ❌ silent |
| `sample --where categories.primary=X` | empty, exit 0 | ❌ silent |

This is the wrong way round. The Skill's own troubleshooting flow says
*"3. Count before pulling"* and *"Always `count` before downloading anything
large"* — so an agent following the documented sequence hits `count` **first**,
gets a clean `0`, and never sees the hint that would have rescued it.

The same gap applies to `roads --class`, `water --class`, `landuse --class`,
and `addresses --postcode`, none of which have any near-match hinting. This is
listed as "still open" in the design thesis; the `count` case is the one worth
closing first, because it sits at the front of the recommended workflow.

Concrete example from the bank: `roads --in Malta --class motorway` → 0 rows,
no hint. Malta has 1,341 `primary` and 1,247 `trunk` segments. The plausible
wrong answer is "Malta has no highways".

---

## 4. `--where` on any list- or struct-typed field crashes with a raw traceback

Severity: **high** — unhandled exception, and the field-validation layer waves
it through.

`--where` validates that the field exists (good — unknown fields get a clean
error listing available fields). But a field that *exists* and is list-typed
passes validation and then explodes inside PyArrow:

```
$ botmap count -t place --in "Cambridge, MA" --where 'categories.alternate=restaurant'
pyarrow.lib.ArrowNotImplementedError: Function 'equal' has no kernel matching
input types (list<element: string>, string)                            [exit 1]

$ botmap count -t place --in "Cambridge, MA" --where 'phones=555'
… equal(list<element: string>, int16)                                  [exit 1]

$ botmap count -t segment --in "Monaco" --where 'road_surface=paved'
… equal(list<element: struct<value: string, between: list<double>>>, string)  [exit 1]

$ botmap count -t segment --in "Monaco" --where 'speed_limits>50'
… greater(list<element: struct<min_speed: …>>, int8)                   [exit 1]
```

Every one of these is a field `schema -t TYPE` advertises. Affected fields
include `categories.alternate`, `websites`, `emails`, `socials`, `phones`,
`addresses`, `names.rules` on `place`; `road_surface`, `speed_limits`,
`access_restrictions`, `routes`, `connectors` on `segment`; and the `*.rules`
fields generally.

Two things to fix: catch the Arrow error and emit a usable message naming the
field's type, and — far more valuable — teach `--where` list membership, so
`categories.alternate=restaurant` means "the list contains restaurant".

That second change is the highest-leverage fix in this document, because it
also unlocks `--where taxonomy.hierarchy=asian_restaurant` — the one command
that would make Overture's whole 6-level category tree queryable. See #6.

---

## 5. `sample` is not a sample

Severity: **high** — the name promises randomness the command does not deliver.

`sample --help` says "Emit the first N features matching the query", which is
accurate. But the verb name says otherwise, and the results are spatially
clustered because they come off the front of the Parquet scan.

Verified deterministic — two consecutive runs return identical ids:

```
$ botmap sample -t building --in "Cambridge, MA" -n 5   (twice)
['acb2da7f-6815-', '5cfbd440-0107-', '67062658-0c70-', '02e8924b-e95b-', '2975410b-7614-']
['acb2da7f-6815-', '5cfbd440-0107-', '67062658-0c70-', '02e8924b-e95b-', '2975410b-7614-']
```

The bias is large. Estimating the residential share of Cambridge buildings:

| method | result |
|---|---|
| `sample -n 400`, count `subtype=residential` | 11/400 = **2.75%** |
| `count` twice (truth) | 9,942/39,977 = **24.9%** |

A **9x** error, from a command an agent will reasonably reach for to
characterise a dataset. The Skill's recipe 3 also frames `sample` as the way to
"confirm shape before committing", which encourages exactly this misuse.

Suggested fix: either add real reservoir sampling behind a `--random` flag, or
rename to `head` / `preview`, or have the human-readable output print
"showing the first N of M (not a random sample)".

---

## 6. The place taxonomy is a 6-level tree, the tree is in the data, and the CLI cannot filter on it

Severity: **high** — the single most likely source of a silently wrong number.

Validated against Overture's published **Place Categories + Basic Categories**
sheet for the new release (2,354 categories, levels 0–5, 284 basic-level).

My first pass called this taxonomy flat. **That was wrong.** It is a genuine
hierarchy, and `asian_restaurant` is an interior node with a 55-category
subtree:

```
food_and_drink > restaurant > asian_restaurant > east_asian_restaurant > chinese_restaurant
food_and_drink > restaurant > asian_restaurant > east_asian_restaurant > japanese_restaurant > sushi_restaurant
food_and_drink > restaurant > asian_restaurant > southeast_asian_restaurant > thai_restaurant
```

The real problem is narrower and worse:

1. `categories.primary` stores only the **leaf**.
2. The **ancestry is present in the data** — `taxonomy.hierarchy` is populated
   on every categorised row and matches the published sheet exactly:
   ```
   categories.primary : pan_asian_restaurant
   taxonomy.hierarchy : ['food_and_drink','restaurant','international_fusion_restaurant','pan_asian_restaurant']
   ```
3. **You cannot filter on it.** `taxonomy.hierarchy` is a list field, so
   `--where taxonomy.hierarchy=asian_restaurant` dies with the same PyArrow
   traceback as #4.

So the CLI ships the hierarchy and then makes it unusable. There is no
hierarchy-aware command available at any level:

| filter | Cambridge MA |
|---|---|
| `categories.primary=asian_restaurant` (the interior node) | **23** |
| union of 9 hand-listed cuisine leaves | **224** |
| `taxonomy.hierarchy=asian_restaurant` (the correct query) | **traceback, exit 1** |
| `basic_category=restaurant` (too coarse — all restaurants) | 1,231 |

Any "how many *&lt;broad category&gt;*" question therefore invites a ~10x
undercount with no error and no hint. The design doc's own worked example
(`asian-restaurants-rollup-vancouver`, ideal path
`--where 'categories.primary=asian_restaurant'`) has exactly this bug.

**Fixing #4 for list fields fixes this too**, and is the highest-leverage change
in this document: `--where taxonomy.hierarchy=asian_restaurant` would make
every rollup in the taxonomy expressible in one command.

Four category-ish fields exist and the Skill documents only the first:

- `categories.primary` — the leaf slug
- `categories.alternate` — list of broader terms; **unfilterable** (#4)
- `taxonomy.primary` — duplicates `categories.primary` in every row sampled
- `taxonomy.hierarchy` — the full ancestor path; **unfilterable** (#4)
- `basic_category` — the sheet's "Basic Level Category", ~94% filled,
  **completely undocumented in the Skill**, and it does *not* take the same
  values as `categories.primary`. `basic_category=pharmacy` returns 0;
  the basic-level value is `pharmacy_and_drug_store`. An agent that assumes the
  two vocabularies interchange gets a silent zero.

### Cross-checks against the published sheet

Two claims elsewhere in this document are confirmed by the authoritative
taxonomy rather than only by sampling:

- **`bus_stop` does not exist as a place category at all** — it appears nowhere
  in the sheet, in any level, under any name. This upgrades #2 from "measured 0
  in three cities" to "the Skill documents a category that Overture does not
  define."
- **`ferry_terminal` likewise does not exist**; `ferry_boat_company` does
  (services_and_business > corporate_or_business_office). The near-match hint
  that suggests it is doing exactly the right thing.

The sheet also records **51 removed** and **106 added** categories plus 214
name changes and 1,583 hierarchy changes in this release, with a
`PC Redirect To` column for the removals. None of that is surfaced anywhere in
the CLI — a `categories --deprecated` or a redirect note in the zero-result
hint would turn a silent zero into a one-step recovery for any agent whose
training data predates the release.

---

## 7. `-r` means `--radius` on `at` and `--release` on every other command

Severity: **medium** — loud failure, but a genuine inconsistency.

| command | `-r` |
|---|---|
| `at` | `--radius` (metres) |
| `download`, `count`, `sample`, `schema`, `categories`, `places`, `buildings`, `roads`, `water`, `landuse`, `addresses` | `--release` |

`at` also has no `-r` shorthand for release — it is `--release` long-form only.

```
$ botmap places --in "Cambridge, MA" --category cafe -r 500
Error: Release '500' is no longer available. …  [exit 2]
```

The error is excellent — it names the problem and lists the two available
releases — so this is recoverable. But an agent that learns `-r 500` from an
`at` example and carries it to `places` will hit it.

---

## 8. Flag coverage is inconsistent across verbs that look parallel

Severity: **medium** — several of these produce usage errors from
reasonable-looking commands.

| flag | has it | notably lacks it |
|---|---|---|
| `--category` | `places` only | `count`, `sample`, `at` |
| `--class` | `roads`, `water`, `landuse` | `buildings` (despite `building.class` existing), `count`, `sample` |
| `-n` / `--limit` | `places`, `buildings`, `roads`, `water`, `landuse`, `addresses`, `at`, `sample` | `count` (fine), `download` (documented) |
| `-f` / `-o` | data verbs, `sample`, `download`, `gers` | `count`, `categories` (fine — `--json` covers them) |
| `--in` / `--bbox` | `download`, `count`, `sample`, `categories`, and all six data verbs | `at`, `containing`, `boundary`, `where` (positional only, by design) |

Two more scoping traps, both confirmed:

- **`--json` is group-level, not per-command.** It must precede the subcommand.
  The Skill's trigger table — the first thing an agent reads — shows
  `where "Boston, MA" --json`, which fails with
  `Error: No such option '--json'. Did you mean '--geojson'?`. Every other
  example in the same file uses the correct `botmap --json where …`. Confusingly
  `--json` *is* a real per-command flag on the six convenience verbs and `at`,
  which is what makes the trailing form look right.
- **`--limit` is not an alias for `-n` everywhere.** It exists only on the six
  convenience verbs; `sample` and `at` accept `-n` alone. `botmap sample -t place
  --limit 5` → `Error: No such option '--limit'.` The Skill states `-n / --limit`
  applies to "`sample`, `at`, and every convenience verb", which is wrong for two
  of the three.

Two of these are worth flagging as likely agent errors:

- **`count --category X`** is the natural way to write "count the coffee
  shops", and it does not exist. The eval design doc's own example ideal path
  (`count -t place --in Brooklyn --category coffee_shop`) is not a valid
  command. `--where categories.primary=X` is required.
- **`at --category X`** likewise does not exist, and Skill recipe 7 shows
  `botmap at 40.7484,-73.9857 -t place --category pharmacy --radius 250 -n 10`
  — which fails with `Error: No such option: --category`. `at` takes `--where`.

Both are documentation bugs as much as CLI bugs; the Skill's own examples do
not run.

---

## 9. `--where` has no substring operator, and the address fix did not generalise

Severity: **medium** — silent zero on a very common shape of query.

Supported operators, determined empirically: `=` `!=` `<` `<=` `>` `>=`
`in [a,b,c]`. Not supported: `~`, `LIKE`, `contains` — all three produce
`Filter '<expr>' has no operator`.

This means the trace-C failure is still fully reproducible on the `--where`
path:

```
$ botmap count -t address --in "Cambridge, MA" --where 'street=Massachusetts Avenue'
{"count": 0}                                                        [exit 0, no hint]

$ botmap count -t address --in "Cambridge, MA" --where 'street=MASSACHUSETTS AVENUE'
{"count": 4140}
```

The `addresses --street` fix (case-insensitive substring) works correctly and
solves this for `addresses`. But `count`, `sample`, and `download` have no
equivalent, so an agent that wants a *count* of addresses on a street — rather
than the addresses themselves — falls straight back into the original hole.

---

## 10. `categories` has no search, so discovery requires `--top N | grep`

Severity: **low-medium** — works, but fragile.

There is no way to ask "which categories match *tattoo*". The only route is to
dump the top N and text-filter client-side:

```
$ botmap --json categories -t place --in "Cambridge, MA" --top 400 | grep -i tattoo
    "value": "tattoo_and_piercing",
```

`--top` is a guess. If the slug ranks below the chosen N the grep returns
nothing and the agent concludes the category does not exist — the same silent
failure the hint mechanism was built to prevent, reintroduced one layer up.
A `categories --search <term>` flag would close it.

Note the global-enumeration guard is good and worth keeping:

```
$ botmap --json categories --top 50
Error: Provide --bbox or --in; global enumeration is too costly.   [exit 2]
```

---

## 11. `land` has no verb and `landuse` is a near-miss for it

Severity: **low-medium** — name collision between adjacent types.

`land_use` has the `landuse` verb. `land` — a different type, holding beach,
cliff, wood, scrub, peak, reef — has **no verb** and is reachable only via
`download -t land`.

An agent asked for beaches will plausibly try `landuse --class beach`, get a
clean empty result, and conclude there are none. Malta has 67
(`land`, `class=beach`).

---

## 13. `download` hard-refuses transit queries on a false premise, and sends you to a command that returns nothing

Severity: **critical** — a working query is blocked, and the suggested
replacement is empty. Both directions are dead ends.

`botmap/cli.py:519-534` contains a hard-coded guard in `download` only:

```python
elif type_ == "infrastructure":
    _TRANSIT_CLASSES = {"bus_stop", "bus_station", "train_station", "transit"}
    is_transit = any(
        (e.startswith("class=") and e.split("=", 1)[1].strip() in _TRANSIT_CLASSES)
        or e.startswith("subtype=transit")
        for e in (where_exprs or [])
    )
    if is_transit:
        raise click.UsageError(
            f"Transit stops are `place` features, not infrastructure — run: "
            f"botmap places --category bus_stop {loc_flag}"
        )
```

Observed:

```
$ botmap download -t infrastructure --in "Cambridge, MA" --where class=bus_stop -f geojsonseq
Error: Transit stops are `place` features, not infrastructure —
       run: botmap places --category bus_stop --in "Cambridge, MA"      [exit 2]
```

**The premise is false and the redirect is broken.** `sample` proves the
features exist in `infrastructure` with exactly the requested properties
(`class=bus_stop subtype=transit name='Faneuil St @ Hobart St'`), and `count`
reports 650 of them. Meanwhile the command it tells you to run —
`places --category bus_stop` — returns 0 rows, because `bus_stop` is not a
place category (#2). The CLI blocks a query that works and hands you one that
doesn't.

This is the same false premise as the Skill's anti-pattern in #2 — one belief,
encoded in two places, wrong in both. Introduced in `e9599d3` alongside the
`division_area` guard, which is legitimate (that type genuinely is not
downloadable this way).

The guard fires before `--in` resolution and before any S3 read, which is why
it returns instantly.

**Fix:** demote the `raise click.UsageError(...)` to the advisory `click.secho`
tip the same branch already emits, so execution continues. The invariant to
restore is that **`download` must never refuse a query `count` answers with a
non-zero number.** Worth a regression test asserting the two verbs agree on
argument acceptance for `infrastructure --where class=bus_stop`; `tests/`
already has CLI tests to hang it off.

### Correction: how I originally mis-reported this

I first published this as "`count` and `download` return different results for
the same filter", with a table showing `download` → 0 rows. That framing was
wrong, and the error was mine: I measured with

```bash
botmap download ... 2>/dev/null | grep -c .
```

which discards stderr and counts stdout lines, turning an `exit 2` usage error
into an apparent "zero matching rows". There is no Parquet, STAC, or predicate
bug — `count`, `sample`, and `download` all funnel into the same
`_prepare_query` in `core.py:228-282` and would agree if the guard let them.

The lesson generalises to the eval itself: **any advisory-turned-`UsageError`
produces this same phantom-zero signature to a caller that silences stderr** —
which is precisely what the thesis (trace F) says agents habitually do. The
original count/download comparison, corrected:

| type | filter | `count` | `download` | `sample -n 5` |
|---|---|---|---|---|
| infrastructure | `class=bus_stop` | 650 | **exit 2, guard** | 5 |
| infrastructure | `subtype=transit` | 4907 | **exit 2, guard** | 5 |
| infrastructure | `class=crossing` | 8825 | 8825 rows | 5 |
| infrastructure | *(no filter)* | 29329 | 29329 rows | — |
| place | `categories.primary=cafe` | 95 | 95 rows | 5 |
| building | `subtype=residential` | 9942 | 9942 rows | 5 |

The asymmetry that looked mysterious is just the string set: `bus_stop` and
`subtype=transit` are in `_TRANSIT_CLASSES`, `crossing` is not. Nothing about
row groups, encoding, or cardinality is involved.

Reproduce — note the absence of `2>/dev/null`, which is what makes it legible:

```bash
botmap --json count -t infrastructure --in "Cambridge, MA" --where class=bus_stop   # 650
botmap download   -t infrastructure --in "Cambridge, MA" --where class=bus_stop \
  -f geojsonseq >/dev/null; echo $?                                                 # 2 + guard message
botmap places --in "Cambridge, MA" --category bus_stop                              # 0 rows — the redirect
```

---

## 14. `--class` shortcuts advertise `subtype` values, and the CLI's own `--help` teaches them

Severity: **high** — a documented flag with documented values that silently
returns nothing.

`--class` maps verbatim to `class=VAL` (`cli.py:1252`). But for `land_use` and
`segment`, several of the values advertised in the help text and Skill live in
the **`subtype`** column, not `class`. Measured in Williamsburg, NY:

| advertised as a `--class` value | `class=` | `subtype=` |
|---|---|---|
| `land_use` `recreation` | **0** | 86 |
| `land_use` `agriculture` | **0** | 0 |
| `segment` `sidewalk` | **0** | 599 (as `subclass`) |

The land_use case is not merely a docs bug — the wrong vocabulary is compiled
into the tool:

```
$ botmap landuse --help
  --class TEXT   Shortcut for --where class=VAL (e.g. commercial,
                 residential, recreation, agriculture)
```

Two of those four examples return zero rows. `residential` and `commercial`
happen to exist as both `class` and `subtype` values, which is exactly why the
list looks plausible. Same text is duplicated in `introspection.py:36` and in
the Skill's cheatsheet, so an agent gets the bad values from three independent
places and has no reason to doubt them.

`sidewalk` is the same shape one level down: its `class` is `footway` and
`sidewalk` is the `subclass`. `roads --class sidewalk` → 0.

Fix: correct the help/Skill lists to real `class` values (`garden`, `farmland`,
`park`, `grass`, `retail`, …), or add `--subtype` / `--subclass` shortcuts so
the advertised vocabulary is reachable. This is the single cheapest place in
the CLI to stop producing confident zeros.

---

## 15. The bank/run-directory layout lets one eval silently overwrite another

Severity: **medium** — corrupts eval artifacts, not user data.

`runner.py:92` writes to `evals/runs/<id>__r<n>` with `mkdir(exist_ok=True)`,
and `score.py` globs `runs/*__r*` and resolves each id against whichever single
bank is passed to `--questions`. Ids are unique *within* a file
(`questions.py` enforces that) but nothing enforces uniqueness *across* files.

There are currently **14 ids colliding across `questions.yaml` and
`questions-tier1..6.yaml`**, so running two banks in sequence overwrites the
first one's artifacts, and scoring bank B against runs left by bank A can flip
`download_is_legitimate` — and therefore the `unnecessary_download` metric —
on a stale directory. `theme-boundary-bus-stops` carries `false` in tier3 and
`true` in tier6 for the identical question, so that metric is decided by
whichever file was scored last.

Fix: assert global id uniqueness across `evals/questions*.yaml` in
`tests/test_eval_questions.py`, and/or namespace run dirs by bank. Cheap
insurance regardless of how the banks are consolidated.

---

## 16. Silent wrong-place resolution — the trace-B fix has a hole

Severity: **critical** — a wrong answer with no signal of any kind.

```
$ botmap --json where "Malta, MT"
  Malta | locality | US/US-MT | bbox=[-107.89, 48.34, -107.86, 48.36]
  stderr: 0 bytes
```

Malta, **Montana**. The ambiguity warning shipped for thesis trace B only fires
when *multiple* candidates match a query. Here exactly one does — it is just
the wrong one — so nothing is emitted. `where "Reykjavik, IS"` likewise
resolves to `Is (locality, ES-AS, pop 2)` in Spain.

Found in the live eval run: both `beach-accessibility-malta` runs queried
Montana, and both `clipping-polygon-qgis` runs backgrounded
`where "Malta, MT" --geometry` — so the polygon they waited twenty minutes for
was probably Montana. **The latency in #1 hid the wrong answer in #16.**

Suggested fix: warn whenever the resolved country/region differs from what the
qualifier implies, even with a single candidate — e.g. a two-letter qualifier
that is a valid US state code resolving to a non-US country, or vice versa.

---

## 17. `categories --top N` truncates silently, manufacturing false negatives

Severity: **high** — turns a discovery command into a source of confident
wrong claims.

| `--top` | rows | `bus_station` present? |
|---|---|---|
| 200 | 200 | **NO** |
| 500 | 500 | YES |
| 5000 | 963 (all) | YES |

There is no "showing 200 of 963" indicator, so an agent that trusts `--top 200`
concludes the category does not exist. Observed consequences in the run:

- `asian-restaurants-rollup__r2`: *"No Vietnamese… categories showed up in
  Cambridge's data"* — `vietnamese_restaurant` exists at count 6.
- `basic-category-rollup__r1`: *"no separate 'drug store' category exists in
  the schema"* — asserted from a truncated `--top 100` grep.
- Both `bus-stops-cambridge` runs found `bus_station` only by guessing a larger
  N after `--top 200` came back without it.

This compounds #10 (no `categories --search`): the only discovery route is a
top-N dump, and the dump silently lies about completeness.

---

## 18. `--class` silently keeps the last value; the comma form silently returns nothing

Severity: **high** — both failure modes exit 0.

```
roads --in Malta --class trunk                  -> 1247
roads --in Malta --class primary                -> 1341
roads --in Malta --class trunk --class primary  -> 1341   # trunk silently dropped
roads --in Malta --class "trunk,primary"        -> exit 0, 0 rows
```

`--class` is declared single-valued, so Click keeps the last occurrence.
Neither form warns. Three runs hit this and recovered only because they
independently cross-checked `wc -l` against a prior `count`; a less careful
agent ships the wrong number with a clean exit code.

Fix: make `--class` repeatable (OR the values), or reject a comma-containing
value with a message naming `--where "class in [a,b]"`.

---

## 12. Assorted smaller notes

- **`download` has an empty help string.** It is the only command with no
  description in `botmap --help`, which is an odd signal for a command the
  design intends to demote — a one-liner pointing at the convenience verbs
  would do useful work here.
- **`boundary` is undocumented in the Skill.** The Skill still teaches
  `where … --geometry` (recipe 16). `boundary <query>` exists and appears to
  be the newer equivalent. Both hang (#1), but the Skill should name the one
  that is meant to win.
- **`operating_status` coverage is extremely uneven** — 65% filled in
  Cambridge MA, 0/300 in Malta, 1/300 in Bengaluru. Values are `open` /
  `permanently_closed` / null. It reads like an "is it open" field and is not
  one; worth a note in the schema cheatsheet, since the natural misuse is
  answering "open right now".
- **The Skill's segment cheatsheet names a field that does not exist.** It
  lists "`subclass`, `surface`, `speed_limits`" — the actual field is
  `road_surface`, and both `road_surface` and `speed_limits` crash under
  `--where` (#4).
- **Ambiguity warnings work well.** `--in "Alameda, CA"` now resolves
  correctly to US-CA (the Saskatchewan bug from the thesis is fixed) and still
  warns. `--in Monaco` warns about region-vs-country. `where --all` is
  accurate. This machinery is in good shape.
- **`where` no_match error is well-formed** but suggests `containing`, which
  hangs (#1), and omits the recovery that actually works for its most likely
  trigger — a diacritic retry (`Reykjavik` fails, `Reykjavík` resolves).

---

## What is working well

Worth recording so it does not get regressed:

- `at` is fast (~7s) and correctly distance-ordered.
- Unknown-field errors are excellent: they name the field and list every valid
  one for that type.
- Malformed `--where` errors are clear and name the expected `K OP V` shape.
- The near-match category hint, where it fires, is genuinely good — it found
  `ferry_boat_company` from `ferry_terminal` and `real_estate_agent` from a
  nonsense string.
- Place-name qualifier handling (`MA`, `US-MA`, `Massachusetts`, `USA`) works
  as documented.
- The `categories` global-enumeration guard prevents an expensive mistake.
- `addresses --street` substring matching works exactly as the thesis claims.

---

## Suggested priority

> Findings #16-#18 were surfaced by the live 60-run eval; see `report.md` for
> the traces. #1's severity is upgraded by that run: the silent latency does not
> merely slow agents, it causes them to abandon the task with a false promise
> ("I'll report back once it finishes") in 9 of 60 runs, and in
> `clipping-polygon-qgis` it concealed the wrong-place bug in #16.

1. **#1** — emit a progress line on stderr from the division-geometry paths.
   Highest value per line of code: it converts most of the nine observed
   abandonment failures into passes without touching the model.
2. **#16** — silent cross-region resolution. A wrong answer with no signal,
   and #1's latency can hide it completely.
3. **#13 + #2 together** — one false premise ("bus stops are `place` features")
   is encoded in both a hard `UsageError` in `download` and the Skill's
   anti-patterns. It blocks a query that works and redirects to one that returns
   nothing. Demote the guard to an advisory tip and fix `bus_stop` →
   `bus_station` in the Skill; add a regression test that `download` never
   refuses what `count` answers non-zero.
2. **#4 + #6 together** — make `--where` handle list membership. One change
   stops the tracebacks *and* turns `taxonomy.hierarchy` into a working rollup
   filter, which removes the largest source of silently-wrong numbers in the
   whole surface.
3. **#1** — three verbs take ten to twenty minutes and emit nothing; an agent
   cannot tell them from a deadlock. At minimum add a stderr progress line.
4. **#3** — move the near-match hint onto `count`, which is where the
   documented workflow sends agents first.
5. **#14** — `landuse --help` and the Skill advertise `--class` values that live
   in `subtype`. The bad vocabulary is compiled into `cli.py` and
   `introspection.py`, so it reaches agents from three places at once.
6. **#8 / #2** — fix the Skill examples that do not run: `at --category`,
   `where … --json`, `sample --limit`, `count --category`, `--category
   bus_stop`. Documentation that fails on copy-paste is worse than none.
7. **#5** — rename or re-label `sample`; it is a `head`.
8. **#6 (docs half)** — document `basic_category` and its separate vocabulary.
9. **#15** — assert global id uniqueness across the question banks before the
   next eval run overwrites artifacts.
