# Agent-Usability Eval Report

Run: `3`

Total runs scored: **30**
Total cost: **$7.19** · tokens: **8,892,884** · wall-clock: **58.4 min**

## Per-question rates

| Question | Tier | Runs | Download | Unnecessary DL | Error | Completed | Avg cmds | Avg $ | Avg tokens | Avg s |
|---|---|---|---|---|---|---|---|---|---|---|
| buildings-monaco | 1 | 2 | 0% | 0% | 100% | 100% | 4.0 | $0.262 | 334,750 | 37.6 |
| busstops-coffee-williamsburg | 5 | 2 | 50% | 50% | 100% | 100% | 11.5 | $0.323 | 484,660 | 259.5 |
| cafes-cambridge-ma | 1 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.298 | 336,388 | 94.7 |
| coffee-brooklyn-count | 1 | 2 | 0% | 0% | 0% | 100% | 1.5 | $0.141 | 133,496 | 20.3 |
| containing-point | 3 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.162 | 175,822 | 135.0 |
| hardware-near-bikepaths-alameda | 5 | 2 | 0% | 0% | 0% | 100% | 5.0 | $0.567 | 1,035,712 | 589.3 |
| hospitals-count-rhode-island | 1 | 2 | 0% | 0% | 0% | 100% | 4.0 | $0.301 | 334,700 | 192.8 |
| landuse-brooklyn | 4 | 2 | 50% | 0% | 0% | 100% | 2.0 | $0.169 | 193,454 | 32.3 |
| point-query-rome | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.196 | 136,944 | 81.9 |
| pois-near-point | 3 | 2 | 0% | 0% | 50% | 100% | 2.0 | $0.254 | 297,358 | 67.4 |
| restaurant-categories-brooklyn | 2 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.225 | 282,358 | 63.2 |
| schema-introspection-places | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.189 | 135,664 | 67.3 |
| tall-buildings-manhattan | 2 | 2 | 0% | 0% | 0% | 100% | 3.0 | $0.187 | 235,876 | 61.2 |
| water-downtown-boston | 4 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.188 | 217,329 | 39.3 |
| where-boston | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.132 | 111,934 | 10.6 |

## Ranked error clusters

- **malformed_bbox_or_coords** in `buildings-monaco` ×2
  - `botmap --json count -t building --in Monaco, MC`
  - `botmap --json count -t building --in Monaco, MC`
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

### 1. Reverse the `download -t infrastructure` transit block — bus stops are infrastructure, not places  _(target: cli)_
**Evidence:** busstops-coffee-williamsburg (tier 5, error_rate 1.0, avg 11.5 commands, avg 259s — the slowest tier-5 question). Ground truth from the run logs: `count -t place --bbox <williamsburg> --where categories.primary=bus_stop` → **count: 0**, while `count -t infrastructure --bbox <same> --where class=bus_stop` → **count: 93**. The `bad_option` cluster is `download -t infrastructure --where class=bus_stop` being killed by the hard UsageError at botmap/cli.py:519-536 ("Transit stops are `place` features, not infrastructure"), which redirected the agent onto a path that returns zero rows. The `bad_category_value` cluster in the same question is the resulting `places --category bus_stop` → `[botmap] 0 rows … Did you mean: bus_station?`. A prior improvement round (docs/automated-improvements/report-example-03.md:60-62) introduced this block on the false premise; it now blocks the only correct query.

In botmap/cli.py:519-540, delete the `_TRANSIT_CLASSES` / `is_transit` branch and its `raise click.UsageError(...)`. Replace the whole `elif type_ == "infrastructure":` body with a verb tip pointing at the new `transit` verb: `[botmap] Tip: try instead: botmap transit --class bus_stop --bbox …`. Never raise for `-t infrastructure`. Add a regression test in tests/test_cli_download.py asserting `download -t infrastructure --where class=bus_stop` exits 0 and that the emitted tip names `transit`, not `places`.

### 2. Fix the skill's bus-stop guidance — it teaches a category that returns 0 rows  _(target: skill)_
**Evidence:** botmap/data/skill.md asserts in three places that transit stops are place features: recipe 15 (skill.md:185-186, `places --in "Williamsburg, NY" --category bus_stop`), the schema cheatsheet (skill.md:210, bolded `bus_stop, bus_station, train_station` under `categories.primary`), and the anti-patterns list (skill.md:258-259, "Use `places --category bus_stop` … not `download -t infrastructure`"). Measured against release 2026-07-22.0: `categories.primary=bus_stop` yields 0 rows in the Williamsburg bbox; `infrastructure class=bus_stop` yields 93. Both runs of busstops-coffee-williamsburg followed the skill, hit 0 rows, and burned 4 escalating `categories --top 100/200/300/500/1000` rescans plus 2 `schema -t infrastructure` calls recovering.

Edit botmap/data/skill.md: (1) rewrite recipe 15 to `botmap transit --bbox "$BBOX" --class bus_stop -f geojsonseq -o busstops.jsonl` with the note `# Bus stops / platforms / stations are INFRASTRUCTURE (class=bus_stop), not places.`; (2) in the cheatsheet at line 210 remove `bus_stop` from the `categories.primary` examples and add a new row: `| infrastructure | base | class (bus_stop, bus_station, train_station, parking, pier, ...); subtype (transit, ...). Use the transit verb. |`; (3) rewrite the anti-pattern at lines 257-259 to the inverse: "**Bus stops are `infrastructure`, not `place`.** `places --category bus_stop` returns 0 rows. Use `transit --class bus_stop`. Only `bus_station` exists as a place category."

### 3. Add a `transit` convenience verb over `infrastructure` (closes the last download-only type in the eval set)  _(target: cli)_
**Evidence:** `infrastructure` is the one type an agent could not reach without `download`: TYPE_TO_VERB (botmap/cli.py:310-319) covers place/segment/building/address/water/land_use/division_area but not infrastructure. The single unnecessary_download in the whole 30-run set is `download -t infrastructure --bbox … --where class=bus_stop`, and the recovery path the agent eventually found was `sample -t infrastructure --where class=bus_stop -n 200`, i.e. abusing `sample` as a data verb because no verb existed.

Add `@cli.command() def transit(...)` in botmap/cli.py modeled exactly on `landuse` (cli.py:1327-1372): options `--in`, `--bbox`, `--class` (`transit_class`, mapped to `ParsedFilter(key="class", op="=", ...)`), `--subtype`, `--where`, `-n/--limit`, `-f`, `-o`, `-r`, reading type `"infrastructure"` via `_safe_reader`. Docstring: "Bus stops, stations, platforms and other transit/infrastructure points." Register `"infrastructure": "transit"` in TYPE_TO_VERB so `download -t infrastructure` emits the standard `_suggest_verb_command` tip. Add tests/test_cli_intents_transit.py mirroring tests/test_cli_intents_landuse.py.

### 4. Fix null-propagating `pc.or_` in geocoding qualifier filter — every country-level place fails with `--in "Name, CC"`  _(target: cli)_
**Evidence:** buildings-monaco: error_rate 1.0 (2/2 runs). Both runs ran `--json where Monaco` (exit 0), then `--json count -t building --in "Monaco, MC"` → exit 2: `No division found for 'Monaco, MC'. The qualifier 'MC' matched nothing, but 'Monaco' alone resolves to Monaco (region, MC, pop 39,050).` The message is self-contradictory — the resolved row's own qualifier IS `MC`. Root cause: botmap/geocoding.py:183-185 builds the mask with `pc.or_(pc.or_(country_match, region_match), region_suffix_match)`; `pc.or_` is not Kleene, so `true OR null == null` and every division with a NULL `region` (all countries, plus city-states like Monaco, Singapore, Vatican, Hong Kong) is dropped even when `country` matches exactly. skill.md:32-35 explicitly advertises the `"Place, CC"` / `"Place, CCC"` forms, so the agent follows documented syntax into a guaranteed error. This was diagnosed in evals/proposals-2.json and is still unfixed.

In botmap/geocoding.py:183-185 replace both `pc.or_` calls with `pc.or_kleene`, then wrap the combined mask in `pc.fill_null(mask, False)` before `filtered.filter(...)` (needed because `pc.ends_with` also returns null on a null region). Add tests in tests/test_geocoding.py asserting `resolve("Monaco, MC")`, `resolve("Monaco, MCO")` and `resolve("Singapore, SG")` each return the same top division as the unqualified query.

### 5. Give `count` the `--at` / `--radius` proximity options that `at` already has  _(target: cli)_
**Evidence:** pois-near-point error cluster (bad_option, count 1): `--json count -t place --at 40.7128,-74.0060 --radius 150` → exit 2, `Error: No such option: --at Did you mean --type?`. The agent had just run `at 40.7128,-74.0060 -t place --radius 150 -n 50` successfully and reasonably assumed the same locator worked on `count`; it recovered by re-running `at … -n 1000 -o /tmp/pois150.jsonl` and counting lines — a full data pull to answer a count. `count` (cli.py:776-813) accepts only `--bbox` / `--in`.

Add `--at LAT,LON` and `--radius METERS` to `count` in botmap/cli.py:776-785, reusing `_parse_latlon` and `intents.bbox_around_point` / `DEFAULT_RADIUS_BY_TYPE` exactly as `at` does (cli.py:1462-1468); make `--at` mutually exclusive with `--bbox`/`--in` with the same UsageError style, and include `"at": [lat, lon], "radius": radius` in the `--json` payload. Apply the identical treatment to `categories` (cli.py:958-969) so "what's near here" works uniformly across count/categories/at. Extend tests/test_cli_count.py and tests/test_cli_at.py.

### 6. Add `--category` to the `at` verb — skill.md documents a flag that does not exist  _(target: cli)_
**Evidence:** skill.md:136 (recipe 7, the recipe the skill designates as *the* tool for "near X" questions) prints `botmap at 40.7484,-73.9857 -t place --category pharmacy --radius 250 -n 10`. `python -m botmap at --help` lists only `-t/--type, -n, -r/--radius, --where, -f, -o, --release`. Any agent copying the documented recipe gets `Error: No such option: --category` — the same bad_option class already observed on `count --at`. It has not fired yet only because no eval question combined proximity with a category.

Add `@click.option("--category", required=False, type=str, help="Shortcut for --where categories.primary=VAL")` to `at` (botmap/cli.py:1444-1461) and append `ParsedFilter(key="categories.primary", op="=", value=category)` to `where_filters`, mirroring `places` (cli.py:1117-1120). Also reuse the `places` zero-result `_suggest_categories` hint block (cli.py:1139-1168) when `--category` yields no rows. Add a test in tests/test_cli_at.py asserting `at LAT,LON --category cafe` filters, and a docs test asserting every flag shown in skill.md recipes exists in `--json capabilities`.

### 7. Make `categories` self-terminating — report total distinct count and support substring search  _(target: cli)_
**Evidence:** busstops-coffee-williamsburg burned 4 of its 11.5 average commands on `categories -t place --bbox … --top 100`, `--top 200`, `--top 300`, `--top 500`, `--top 1000` — each a full re-scan of the bbox — because the output is a bare truncated array with no signal of how many distinct values exist. The agent was hunting for `bus_stop`, which was never in the list at any `--top` value. This question cost avg $0.32 and 259s, the worst duration in the set.

In `categories` (botmap/cli.py:1017-1023): (1) compute `total_distinct = len(counts)` and emit `{"total_distinct": N, "shown": len(payload), "truncated": bool, "values": [...]}` in `--json` mode (plain-text mode prints a trailing `… N distinct categories, showing top K`); (2) add `--match SUBSTR` that filters `counts` case-insensitively before ranking and ignores `--top`, so `categories --match bus` answers "does bus_stop exist here?" in one call; (3) when `--match` returns nothing, print `[botmap] No category matching 'bus' — bus stops are infrastructure, try: botmap transit --class bus_stop`. Extend tests/test_cli_capabilities.py and add tests/test_cli_categories.py.

### 8. Emit the verb hint from `count`, at the moment the agent picks its fetch command  _(target: hint)_
**Evidence:** coverage_gaps: land_use / landuse-brooklyn. A `landuse` verb already exists, yet run r1 went `count -t land_use --bbox …` → `download -t land_use --bbox … -f geojsonseq -o /tmp/brooklyn_landuse.jsonl`, and only *then* saw `[botmap] Tip: try instead: botmap landuse --bbox …` — after the bytes were already streaming. Run r2, on the identical question, used `landuse` directly. The deciding moment is the `count -t TYPE` call that precedes the fetch: `count` is the only type-keyed command with no verb steering, so `count -t TYPE` → `download -t TYPE` reads as the natural symmetric pair.

In `count` (botmap/cli.py:805-813), after emitting the result and when `TYPE_TO_VERB.get(type_)` is set, print to stderr: `[botmap] Tip: to fetch these, run: {_suggest_verb_command(verb, in_place, bbox, where_exprs, None, None)}` — reusing the existing helper at cli.py:321-346 so the suggestion is copy-pasteable with the caller's own filters already translated to `--category` / `--class`. Do the same in `sample`. Add a test in tests/test_cli_count.py asserting `count -t land_use --bbox …` puts `botmap landuse --bbox …` on stderr.

### 9. Alias the verb names to the type names (`land_use`, `land-use`, `infrastructure`) so type-first guesses resolve  _(target: cli)_
**Evidence:** Every type-keyed command spells the type `land_use` (`count -t land_use`, `schema -t land_use`, `download -t land_use`) but the verb is spelled `landuse` — the one name mismatch in TYPE_TO_VERB (cli.py:310-319). landuse-brooklyn r1 stayed on `download -t land_use` after already typing `land_use` twice; the underscore-free verb is a second thing to remember at exactly the point where the agent is trying to avoid `download`.

Add a `click.Group` subclass overriding `get_command` to resolve aliases before falling through to `super().get_command`, wired as `@click.group(cls=AliasedGroup, invoke_without_command=True)` at botmap/cli.py:442. Map `{"land_use": "landuse", "land-use": "landuse", "infrastructure": "transit", "poi": "places", "pois": "places", "segments": "roads"}`. Also override `resolve_command` so `botmap land_use --help` shows the canonical name. Exclude aliases from `_walk_group` (cli.py:292-299) so `--json capabilities` still advertises exactly one name per command. Add tests in tests/test_cli_capabilities.py.

### 10. Rename `at`'s `-r` to `--radius`-only — it collides with the `-r/--release` convention on every other command  _(target: cli)_
**Evidence:** `at` (botmap/cli.py:1450) binds `-r, --radius`, while `count`, `sample`, `places`, `buildings`, `roads`, `water`, `landuse`, `addresses`, `categories` and `download` all bind `-r, --release`. `at` is also the only data command whose release flag has no short form. An agent that has just run `count -t place --in X -r 2026-07-22.0` and then reaches for `at LAT,LON -r 2026-07-22.0` gets no error at all — Click parses `2026-07-22.0` as an int radius and fails with a type error, or worse silently mis-scopes the search. This is a silent-wrong-answer class, which the taxonomy in evals/taxonomy.py cannot even detect.

In botmap/cli.py:1450 drop the `-r` short form from `--radius` (leave `--radius` long-form only), and add `-r` to `at`'s `--release` option at cli.py:1459 so the short flag means the same thing everywhere. Update skill.md recipe 7 (line 135-136) which already uses the long `--radius` form, and add a test in tests/test_cli_capabilities.py that asserts no two commands bind the same short flag to different destinations.

