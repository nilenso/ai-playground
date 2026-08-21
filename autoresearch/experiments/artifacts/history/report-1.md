# Agent-Usability Eval Report

Run: `1`

Total runs scored: **20**
Total cost: **$4.70** · tokens: **6,335,993** · wall-clock: **42.6 min**

## Per-question rates

| Question | Tier | Runs | Download | Unnecessary DL | Error | Completed | Avg cmds | Avg $ | Avg tokens | Avg s |
|---|---|---|---|---|---|---|---|---|---|---|
| busstops-coffee-williamsburg | 5 | 2 | 50% | 50% | 100% | 100% | 11.5 | $0.323 | 484,660 | 259.5 |
| coffee-brooklyn-count | 1 | 2 | 0% | 0% | 0% | 100% | 1.5 | $0.141 | 133,496 | 20.3 |
| containing-point | 3 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.162 | 175,822 | 135.0 |
| hardware-near-bikepaths-alameda | 5 | 2 | 0% | 0% | 0% | 100% | 5.0 | $0.567 | 1,035,712 | 589.3 |
| landuse-brooklyn | 4 | 2 | 50% | 0% | 0% | 100% | 2.0 | $0.169 | 193,454 | 32.3 |
| pois-near-point | 3 | 2 | 0% | 0% | 50% | 100% | 2.0 | $0.254 | 297,358 | 67.4 |
| restaurant-categories-brooklyn | 2 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.225 | 282,358 | 63.2 |
| tall-buildings-manhattan | 2 | 2 | 0% | 0% | 0% | 100% | 3.0 | $0.187 | 235,876 | 61.2 |
| water-downtown-boston | 4 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.188 | 217,329 | 39.3 |
| where-boston | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.132 | 111,934 | 10.6 |

## Ranked error clusters

- **bad_category_value** in `busstops-coffee-williamsburg` ×1
  - `botmap places --bbox -73.96245306396484,40.70561868286133,-73.94443780517578,40.723622497558594 --category bus_stop -f geojsonseq -o busstops.jsonl`
- **bad_option** in `busstops-coffee-williamsburg` ×1
  - `botmap download -t infrastructure --bbox -73.96245306396484,40.70561868286133,-73.94443780517578,40.723622497558594 --where class=bus_stop -f geojsonseq -o busstops.jsonl`
- **bad_option** in `pois-near-point` ×1
  - `botmap --json count -t place --at 40.7128,-74.0060 --radius 150`

## Coverage gaps (legitimate downloads)

- type **land_use** — wanted by: landuse-brooklyn

## Unnecessary download (agent failures)

- `busstops-coffee-williamsburg`:
  - `botmap download -t infrastructure --bbox -73.96245306396484,40.70561868286133,-73.94443780517578,40.723622497558594 --where class=bus_stop -f geojsonseq -o busstops.jsonl`

## Proposed improvements

### 1. Add --at/--radius to `count` so proximity questions never dead-end  _(target: cli)_
**Evidence:** pois-near-point (error_rate 0.5, wasted_commands 1): `botmap --json count -t place --at 40.7128,-74.0060 --radius 150` → 'no such option' (bad_option). The agent correctly reasoned 'count before pulling' but `count` only accepts --bbox/--in, while `at` is the only proximity-aware command.

In botmap/cli.py `count` (line 776-813), add `@click.option('--at', 'latlon', type=str)` and `@click.option('--radius', type=float, default=None, help='Meters; requires --at')`, parsed with the existing `_parse_latlon`. When --at is given, derive the bbox from the radius the same way `at` (line 1444) does and apply the same haversine distance filter before counting, so `count --at LAT,LON --radius 150` returns the number `at` would emit. Reject --at together with --bbox/--in with the existing mutual-exclusion UsageError wording. Mirror it the other way too: add `--count` to `at` so `botmap --json at LAT,LON -t place --radius 150 --count` prints `{"count": N}` without streaming features.

### 2. Turn Click's 'no such option' into a command-aware redirect hint  _(target: hint)_
**Evidence:** 2 of 3 ranked error clusters are `bad_option` (busstops-coffee-williamsburg, pois-near-point). Click's default message ('Error: No such option: --at') names no alternative, so the agent must guess a recovery, costing a wasted command each time (avg_commands 11.5 on the tier-5 question).

Add a `SuggestiveCommand(click.Command)` subclass in botmap/cli.py that overrides `parse_args` to catch `click.NoSuchOption` and re-raise a `UsageError` enriched from a module-level table, e.g. `OPTION_REDIRECTS = {('count','--at'): 'proximity queries live on `at`: botmap at LAT,LON -t TYPE --radius M (add --count for a number)', ('count','--radius'): same, ('places','--class'): 'places filters by --category; --class is for roads/water/landuse', ('roads','--category'): 'segments use --class, not --category', ('download','-n'): 'download has no --n; use a convenience verb or `sample -n`'}`. Fall back to `difflib.get_close_matches` over the command's declared option names ('Unknown option --catagory. Did you mean --category?'). Set `cls=SuggestiveCommand` on every `@cli.command()`.

### 3. Auto-redirect `download -t infrastructure` transit queries instead of erroring  _(target: cli)_
**Evidence:** busstops-coffee-williamsburg r2: `download -t infrastructure --bbox … --where class=bus_stop` hit the `raise click.UsageError(...)` at botmap/cli.py:531 → nonzero exit, classified bad_option, error_rate 1.0 for the question. The steering text was correct but the run still counts as an error and burns a turn.

In botmap/cli.py:519-541, replace the hard `UsageError` for the transit case with a transparent redirect: emit the yellow `[botmap] Transit stops are `place` features — running `botmap places --category bus_stop <loc>` instead.` on stderr, then `ctx.invoke(places, bbox=bbox, in_place=in_place, category=<the class= value>, where_exprs=<remaining exprs>, limit=None, output_format=output_format, output=output, release=release)` and return with exit 0. Do the same for `download -t division_area` (line 510-514), which currently also hard-errors: invoke `boundary`/`where --geometry` instead. Keep a hard error only when the redirect is genuinely impossible.

### 4. Make `download` refuse (with a ready-to-run verb) whenever a convenience verb fully covers the call  _(target: cli)_
**Evidence:** landuse-brooklyn r1 ran `download -t land_use --bbox -73.975,40.685,-73.965,40.695 -f geojsonseq -o …` even though the `landuse` verb (cli.py:1322) accepts exactly those flags and TYPE_TO_VERB already maps land_use→landuse. The existing tip at cli.py:515 is a bright_black stderr line the agent can ignore, and it did: download_rate 0.5 on that question.

In botmap/cli.py:504-518, escalate the tip to a `UsageError` when `_suggest_verb_command` can express the whole invocation losslessly (i.e. every `--where` was folded into --category/--class, or there are no leftovers the verb can't take — the verbs accept --where anyway, so this is nearly always true): `raise click.UsageError(f"`download -t {type_}` is the low-level escape hatch; the covering command is: {suggestion}\nRe-run download with --force (or BOTMAP_FORCE_DOWNLOAD=1) if you really need the raw path.")`. Add `@click.option('--force', is_flag=True)` to `download` as the documented escape hatch. Types with no verb (infrastructure non-transit, division, etc.) keep working unchanged.

### 5. Add a `classes` command so class-based types never need a download to explore  _(target: cli)_
**Evidence:** coverage_gaps: {land_use: [landuse-brooklyn]}. The r1 agent downloaded 74 land_use polygons purely to produce a class histogram (pitch 12, garden 10, playground 9, …). `categories` (cli.py:958) hard-errors for any non-place type at line 971-983, telling the agent to read `schema` — which lists field names, not actual values in the area. Downloading was the only way to learn which classes exist.

Add `@cli.command('classes')` in botmap/cli.py modeled on `categories`: options `-t/--type` (default `land_use`, any type whose schema has a top-level `class`), `--bbox`/`--in`, `--top`, `-r`. Reuse the `categories` batch loop but do `pc.value_counts(batch.column('class'))`, emitting `[{"value": "residential", "count": 812}, …]` under `--json`. Then change the `categories` non-place branch (cli.py:971-983) from a UsageError into a delegation: `click.secho('[botmap] `categories` is place-only; `class` is the classifying field for {type_} — running `classes` instead.', err=True)` followed by `ctx.invoke(classes, ...)`. Register the same handling for `water`, `segment`, and `building`.

### 6. Fix the skill's false claim that bus_stop is a populated place category  _(target: skill)_
**Evidence:** botmap/data/skill.md recipe 15 (line 183-188), the schema cheatsheet (line 210, bolds **bus_stop, bus_station, train_station**), and the anti-pattern at line 257 all assert transit stops are `place` features. The r1 agent followed that exactly — `places --bbox … --category bus_stop` — and got 0 rows (bad_category_value); its final answer: 'Overture's places data has zero bus_stop-category POIs anywhere in New York State in release 2026-07-22.0'. The skill's confident wording is what caused 10 commands and a dead end.

Rewrite recipe 15 to lead with verification and an explicit sparsity warning: "### 15. Transit stops (verify coverage first — often absent)\n```bash\n# Overture's places theme carries transit POIs only where a source fed them in;\n# bus_stop is EMPTY across many regions (e.g. all of New York State as of 2026-07).\n# Always check before building on it:\nbotmap --json categories -t place --in \"Brooklyn, NY\" --top 100 | jq '.[] | select(.value|test(\"bus|transit|station\"))'\n# If bus_stop is absent, say so and stop — bus_station/train_station are terminals,\n# not stops, and `download -t infrastructure` does NOT contain them either.\n```". Change the line 210 cheatsheet cell to `categories.primary (hotel, restaurant, cafe, hospital, …; transit values like bus_stop are sparse — verify with `categories` before relying on them)` and amend the line 257 anti-pattern to keep the 'not infrastructure' steer while dropping the implication that the data exists.

### 7. Make the zero-rows hint distinguish 'wrong spelling' from 'not in this dataset'  _(target: hint)_
**Evidence:** The `places` zero-result hint (botmap/cli.py:1139-1168) fires 'Did you mean: …?' for `--category bus_stop`, which the eval taxonomy classifies as bad_category_value. But the value was not misspelled — it is genuinely absent from the release. The suggestion sent the agent looking for a near-match that does not exist, and it then widened the search to all of New York State before concluding.

In botmap/cli.py:1150-1168, split the hint on the quality of `_suggest_categories`: only say 'Did you mean: X?' when a candidate is a close string match (difflib ratio ≥ 0.7). Otherwise emit an absence-framed message: `[botmap] 0 rows. categories.primary='bus_stop' exists in Overture's schema but has no features in this bbox. Top categories actually present here: cafe, restaurant, … . Note: transit categories (bus_stop, tram_stop) are unpopulated in many regions — widen once with `count -t place --in "<state>" --where categories.primary=bus_stop` and if that is also 0, the data is not in this release; report that rather than searching further.` Add the identical absence hint to the `--class` verbs (`roads`, `water`, `landuse`, cli.py:1235/1287/1340), which today print nothing at all on 0 rows.

### 8. Remove `download` from the skill's only composition recipe  _(target: skill)_
**Evidence:** botmap/data/skill.md recipe 11 (line 156-162) is titled 'Compose where + download' and shows `botmap download -t place --bbox "$BBOX" --where categories.primary=hotel`. It is the single worked example of piping a resolved bbox into a data command, so an agent that needs the bbox→data pattern copies `download` verbatim — the exact behavior the eval penalizes.

Retitle to '### 11. Compose where + a verb' and replace the body with `BBOX=$(botmap --json where "Berlin" | jq -r '.bbox | join(",")')` / `botmap places --bbox "$BBOX" --category hotel -f geojsonseq -o berlin_hotels.jsonl`, plus a one-line note: 'Every verb takes --bbox, so you never need `download` to consume a computed bbox.' Then add a top-of-file rule under 'When to reach for this CLI': '**Never run `download`.** It is a raw escape hatch for types with no verb. place→places, segment→roads, building→buildings, address→addresses, water→water, land_use→landuse, division_area→`where … --geometry`. If you think you need `download`, run `botmap --json capabilities` and pick the verb.'

### 9. Teach `capabilities` to name the preferred command per type and demote `download`  _(target: cli)_
**Evidence:** skill.md line 43-46 tells the agent 'If you forget the surface, run `botmap --json capabilities`' — the designated self-discovery path. That manifest (botmap/introspection.py, `_walk_group`/`_describe_command` at cli.py:284-300) lists `download` as a peer of the verbs with no indication it is a fallback, so a self-discovering agent has no signal to prefer `places`/`landuse`.

In `_describe_command` (botmap/cli.py:284), add two fields: `"tier": "preferred" | "advanced"` (download, gers, cache → advanced; everything else preferred) and, for `download`, `"prefer_instead": TYPE_TO_VERB` so the manifest literally carries `{"place":"places","land_use":"landuse","division_area":"boundary",…}`. Emit a top-level `"type_to_command"` block in the `capabilities` payload (cli.py:1029) mapping every Overture type to its covering verb plus the proximity note (`"near a point" -> at`). Change `download`'s `short_help` to `[advanced] Raw type download — prefer places/roads/buildings/water/landuse/addresses` so it reads that way in plain `botmap --help` too.

### 10. Score `download -t land_use` as an unnecessary download in the eval harness  _(target: docs)_
**Evidence:** The evidence reports landuse-brooklyn as `coverage_gaps: {land_use: [...]}` with `unnecessary_download: false`, yet botmap/cli.py:310-318 maps land_use→`landuse` and the verb accepts the identical `--bbox -f -o` flags the run used. The harness is under-counting avoidable downloads, which will hide regressions on exactly the metric being optimized.

In evals/score.py, derive the 'covered by a verb' set from `botmap.cli.TYPE_TO_VERB` instead of a hardcoded list, and classify a download as unnecessary whenever its `-t` is a key of that map and every other flag it used is also accepted by the target verb (bbox/in/where/-f/-o/-n). Reserve `coverage_gaps` for types with no TYPE_TO_VERB entry (infrastructure, division, etc.). Re-run the 20-run suite afterward; landuse-brooklyn r1 should move from coverage_gap to unnecessary_download, making proposal 4's hard-fail the measurable fix.

