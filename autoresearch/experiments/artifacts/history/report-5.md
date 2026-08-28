# Agent-Usability Eval Report

Run: `5`

Total runs scored: **60**
Total cost: **$21.42** · tokens: **28,152,476** · wall-clock: **190.0 min**

## Per-question rates

| Question | Tier | Runs | Download | Unnecessary DL | Error | Completed | Avg cmds | Avg $ | Avg tokens | Avg s |
|---|---|---|---|---|---|---|---|---|---|---|
| asian-restaurants-rollup | 2 | 2 | 0% | 0% | 0% | 100% | 7.5 | $0.304 | 315,869 | 180.9 |
| basic-category-rollup | 2 | 2 | 0% | 0% | 0% | 100% | 5.0 | $0.413 | 572,548 | 350.3 |
| bbox-cambridge | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.178 | 134,286 | 10.8 |
| beach-accessibility-malta | 5 | 2 | 0% | 0% | 0% | 100% | 13.0 | $0.658 | 1,009,272 | 470.8 |
| bike-parking-coverage | 5 | 2 | 100% | 0% | 0% | 100% | 15.5 | $0.655 | 942,336 | 519.7 |
| brooklyn-every-building | 3 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.235 | 257,622 | 109.6 |
| building-parts-detail | 5 | 2 | 50% | 0% | 50% | 100% | 6.5 | $0.512 | 805,360 | 172.5 |
| bus-stops-cambridge | 3 | 2 | 0% | 0% | 50% | 100% | 5.5 | $0.319 | 429,906 | 106.7 |
| bus-stops-with-coffee | 5 | 2 | 0% | 0% | 0% | 100% | 9.5 | $0.365 | 492,542 | 292.5 |
| clipping-polygon-qgis | 4 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.304 | 359,758 | 147.6 |
| ev-charging-gap | 4 | 2 | 50% | 50% | 50% | 100% | 6.0 | $0.471 | 677,813 | 445.0 |
| hardware-near-bikepaths | 5 | 2 | 0% | 0% | 0% | 100% | 5.5 | $0.365 | 554,494 | 179.0 |
| hospitals-rhode-island | 1 | 2 | 0% | 0% | 0% | 100% | 3.5 | $0.269 | 260,436 | 106.3 |
| hotel-density-two-countries | 4 | 2 | 50% | 50% | 100% | 100% | 12.0 | $0.529 | 772,320 | 382.0 |
| junction-density | 5 | 2 | 0% | 0% | 50% | 100% | 10.0 | $0.551 | 817,725 | 247.9 |
| malta-highways-absent-class | 2 | 2 | 0% | 0% | 0% | 100% | 6.0 | $0.606 | 998,284 | 228.6 |
| motorways-rhode-island | 1 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.210 | 214,366 | 137.1 |
| nearest-pois-harvard | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.252 | 145,900 | 28.6 |
| pharmacies-monaco | 1 | 2 | 0% | 0% | 100% | 100% | 3.5 | $0.309 | 271,607 | 38.8 |
| pharmacy-near-address | 4 | 2 | 0% | 0% | 100% | 100% | 5.0 | $0.283 | 332,224 | 107.1 |
| residential-share-cambridge | 3 | 2 | 0% | 0% | 100% | 100% | 7.0 | $0.385 | 541,042 | 199.4 |
| reykjavik-diacritic | 3 | 2 | 0% | 0% | 100% | 100% | 4.5 | $0.352 | 510,838 | 212.5 |
| starbucks-name-vs-brand | 2 | 2 | 0% | 0% | 0% | 100% | 3.0 | $0.261 | 262,712 | 81.3 |
| street-canonical-form | 2 | 2 | 0% | 0% | 50% | 100% | 6.0 | $0.273 | 355,829 | 138.6 |
| tall-buildings-cambridge | 2 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.367 | 500,867 | 206.2 |
| tattoo-category-discovery | 2 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.108 | 40,733 | 5.4 |
| unsupported-hours-and-ratings | 3 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.129 | 63,034 | 7.2 |
| waterfront-buildings-reykjavik | 5 | 2 | 0% | 0% | 100% | 100% | 7.5 | $0.638 | 1,068,494 | 428.6 |
| which-admin-areas | 4 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.202 | 184,757 | 133.5 |
| williamsburg-which-one | 3 | 2 | 0% | 0% | 0% | 100% | 2.0 | $0.207 | 183,264 | 23.9 |

## Ranked error clusters

- **bad_option** in `hotel-density-two-countries` ×3
  - `botmap --json count -t place --bbox 13.936,35.585,14.823,36.283 --where categories.primary=hotel --where addresses.country=MT`
  - `botmap --json count -t place --bbox 5.67,49.44,6.53,50.19 --where categories.primary=hotel --where addresses.country=LU`
  - `botmap where Luxembourg --all --json`
- **malformed_bbox_or_coords** in `pharmacies-monaco` ×2
  - `botmap places --in Monaco, MC --category pharmacy -f geojsonseq`
  - `botmap --json count -t place --in Monaco, MC --where categories.primary=pharmacy`
- **bad_option** in `pharmacy-near-address` ×2
  - `botmap at 42.3663248,-71.1060534 -t place --category pharmacy -n 5`
  - `botmap at 42.3663248,-71.1060534 -t place --category pharmacy -n 5 --json`
- **bad_option** in `residential-share-cambridge` ×2
  - `botmap --json categories -t building --in Cambridge, MA --top 20`
  - `botmap --json categories -t building --in Cambridge, MA --top 30`
- **malformed_bbox_or_coords** in `reykjavik-diacritic` ×2
  - `botmap --json where Reykjavik, Iceland`
  - `botmap --json where Reykjavik, Iceland`
- **malformed_bbox_or_coords** in `waterfront-buildings-reykjavik` ×2
  - `botmap --json where Reykjavik, Iceland`
  - `botmap --json where Reykjavik, Iceland`
- **unknown_command** in `building-parts-detail` ×1
  - `botmap building_part --in Cambridge, MA -f geojsonseq -o cambridge_parts.jsonl`
- **bad_option** in `bus-stops-cambridge` ×1
  - `botmap sample -t place --in Cambridge, MA --where categories.primary=transportation -n 5 --json`
- **bad_option** in `ev-charging-gap` ×1
  - `botmap --json download -t division --bbox -71.1604,42.3524,-71.06397,42.40426 --where subtype=neighborhood`
- **bad_option** in `junction-density` ×1
  - `botmap at 40.7116,-73.9555 -t place --category neighborhood -n 5`
- **bad_option** in `reykjavik-diacritic` ×1
  - `botmap where Reykjavík, Iceland --geometry -o /tmp/reyk.geojson`
- **bad_option** in `street-canonical-form` ×1
  - `botmap --json count -t address --in Cambridge, MA --street Massachusetts Ave`

## Coverage gaps (legitimate downloads)

- type **building** — wanted by: building-parts-detail
- type **building_part** — wanted by: building-parts-detail
- type **infrastructure** — wanted by: bike-parking-coverage

## Unnecessary download (agent failures)

- `ev-charging-gap`:
  - `botmap --json download -t division --bbox -71.1604,42.3524,-71.06397,42.40426 --where subtype=neighborhood`
  - `botmap download -t division --bbox -71.1604,42.3524,-71.06397,42.40426 --where subtype=neighborhood -f geojsonseq -o /tmp/cambridge_ev/neighborhoods.jsonl`
- `hotel-density-two-countries`:
  - `botmap download -t division --bbox 5.73,49.44,6.53,50.19 --where subtype=country -f geojsonseq`

## Proposed improvements

### 1. Add --category to `at` (the skill documents a flag that does not exist)  _(target: cli)_
**Evidence:** bad_option x2 on pharmacy-near-address (`at 42.3663248,-71.1060534 -t place --category pharmacy -n 5`) and x1 on junction-density (`at 40.7116,-73.9555 -t place --category neighborhood -n 5`). botmap/data/skill.md recipe 7 literally shows `botmap at 40.7484,-73.9857 -t place --category pharmacy --radius 250 -n 10`, but `at` (botmap/cli.py:1444-1462) only defines latlon, -t, -n, -r/--radius, --where, -f, -o, --release.

In botmap/cli.py add `@click.option("--category", required=False, type=str, help="Shorthand for --where categories.primary=VALUE (place type only).")` to the `at` command, translating it to `ParsedFilter(key='categories.primary', op='=', value=category)` exactly as `places` does at cli.py:1117-1119, and reuse the `_suggest_categories` near-miss handler on a 0-row result. When `-t` is not `place`, raise a UsageError naming the right field: "--category applies to place features; for `-t <type>` use --class (see `botmap --json schema -t <type>`)" — which also answers the `--category neighborhood` attempt by pointing at `botmap containing LAT,LON` / the new `divisions` verb.

### 2. Accept --json after the subcommand, not just before it  _(target: cli)_
**Evidence:** bad_option on hotel-density-two-countries (`where Luxembourg --all --json`) and bus-stops-cambridge (`sample -t place --in "Cambridge, MA" --where categories.primary=transportation -n 5 --json`), and the `at ... -n 5 --json` retry on pharmacy-near-address. `--json` is only a group-level option (botmap/cli.py:447) so trailing usage is "no such option"; the intent verbs paper over this with a hidden `json_no_op` flag that silently does nothing.

Define a reusable `json_option = click.option("--json", "json_output", is_flag=True, default=False, expose_value=False, is_eager=True, callback=lambda ctx, p, v: ctx.ensure_object(dict).__setitem__("json", True) if v else None)` in botmap/cli.py and attach it to every subcommand (`where`, `boundary`, `count`, `sample`, `categories`, `schema`, `themes`, `types`, `containing`, `capabilities`, `download`, and all intent verbs). Delete the hidden `json_no_op` parameters (cli.py:1100, 1185, 1234, 1286, 1339, 1395, 1461) so `--json` on a feature verb means "emit GeoJSON to stdout" (equivalent to `-f geojson`) instead of being ignored.

### 3. Give `where` and `boundary` an -o/--output flag  _(target: cli)_
**Evidence:** bad_option on reykjavik-diacritic: `where "Reykjavík, Iceland" --geometry -o /tmp/reyk.geojson`. `where` (botmap/cli.py:701-710) has `--geometry/--geojson` but no `-o`, so an agent that wants the polygon on disk either fails or falls back to shell redirection.

Add `@click.option("-o", "--output", required=False, type=click.Path())` to both `where` and `boundary` in botmap/cli.py and thread it into `_emit_division_geometry` (cli.py:1716) so the Feature is written to the path when given and to stdout otherwise. Mention `-o` in the `--geometry` help string so `botmap --json capabilities` advertises it.

### 4. Match place names diacritic-insensitively in the divisions index  _(target: cli)_
**Evidence:** reykjavik-diacritic and waterfront-buildings-reykjavik: 100% error rate, 2 failures each, all from `botmap --json where "Reykjavik, Iceland"`. geocoding.resolve (botmap/geocoding.py:153-160) does `pc.equal(pc.utf8_lower(name_primary), name.lower())`, so the ASCII spelling never matches `Reykjavík`.

In botmap/geocoding.py, add `_fold(s) = unicodedata.normalize('NFKD', s).encode('ascii','ignore').decode().lower()`; store a folded `name_folded` column when the index is built (botmap/cache.py `ensure_index`) and match on it. Keep exact-match rows ranked first, folded matches second. This also lets `--in "Reykjavik, IS"` work on every verb, since they all route through `_resolve_in_place`.

### 5. Fall back when a qualifier names the division's own country (microstates)  _(target: cli)_
**Evidence:** pharmacies-monaco: 100% error rate, both runs failed on `places --in "Monaco, MC"` and `--json count -t place --in "Monaco, MC"`. The qualifier loop in geocoding.resolve (geocoding.py:161-172) intersects on country/region columns, which eliminates the country-level row for a city-state where name == country.

In geocoding.resolve, if qualifier filtering empties the candidate set but the name-only match was non-empty, retry keeping rows where the normalized qualifier equals the row's own country, region, or (for `subtype='country'`) the row's own name, and emit a one-line yellow `[botmap]` note on stderr naming what was used — the same recovery shape `_resolve_in_place` already uses for parent fallback (cli.py:205-222). Add `"MCO": "MC", "MONACO": "MC", "MLT": "MT", "MALTA": "MT", "LUX": "LU", "LUXEMBOURG": "LU"` to `_COUNTRY_ALIASES` (geocoding.py:45-95), which the eval also exercised via Malta and Luxembourg.

### 6. Make `categories` work for non-place types instead of raising UsageError  _(target: cli)_
**Evidence:** bad_option x2 on residential-share-cambridge: `--json categories -t building --in "Cambridge, MA" --top 20` then `--top 30`. botmap/cli.py:970-981 deliberately raises for any `type_ != "place"`, so the agent burned two commands and still had no value list.

Rename the internal behaviour to "enumerate the classifying field": in `categories` (cli.py:958-1024) pick the column by type — `categories.primary` for place, `class` for segment/building/water/land_use/infrastructure, `subtype` for division — and emit `{"field": "class", "values": [{"value":…, "count":…}]}` so the agent learns both the field name and its values in one call. Keep the current message only for types with no classifying field.

### 7. Give `count` and `sample` the same convenience filters as the verbs  _(target: cli)_
**Evidence:** bad_option on street-canonical-form: `--json count -t address --in "Cambridge, MA" --street "Massachusetts Ave"`. `--street`/`--number`/`--postcode` exist only on `addresses` (cli.py:1380-1386) and `--category`/`--class` only on the verbs, so an agent that learned a flag on one command cannot reuse it on `count`.

Extract the flag→ParsedFilter translation into a shared `_convenience_filters(type_, category, class_, street, number, postcode)` helper in botmap/cli.py and attach `--category`, `--class`, `--street`, `--number`, `--postcode` to `count` (cli.py:776-785) and `sample` (cli.py:816-830), raising a typed UsageError naming the correct flag when one is used against the wrong `-t` (e.g. "--street applies to -t address; for places use --category"). Same flag vocabulary on every command that takes `-t`.

### 8. Support list-of-struct paths in --where (addresses.country) or name the working alternative  _(target: cli)_
**Evidence:** hotel-density-two-countries: 3 bad_option calls, all `count -t place --where categories.primary=hotel --where addresses.country=MT|LU`. `addresses` is list<struct> in the place schema, so `ParsedFilter.validate_against_schema` (botmap/filters.py:60-64) fails with "…is not a struct" and the run degrades into a `download`.

In botmap/filters.py, when walking a dotted path, unwrap `pa.types.is_list`/`is_large_list` to its struct value type and compile the leaf comparison with ANY-element semantics (`pc.list_element` + `pc.any` over the struct field). If ANY-semantics is out of scope, at minimum change the ValueError text to be actionable: "`addresses.country` is a list field; filter by country with `--in \"Malta\"` (bbox + division) or `--country MT`" — and add a `--country` option to `places`/`count` that intersects the resolved division's country instead of the record field.

### 9. Add a `divisions` verb so `download -t division` is never needed  _(target: cli)_
**Evidence:** The only unnecessary_download cluster: ev-charging-gap x2 (`download -t division --bbox -71.1604,42.3524,-71.06397,42.40426 --where subtype=neighborhood [-f geojsonseq -o …]`) and hotel-density-two-countries x1 (`download -t division --bbox 5.73,49.44,6.53,50.19 --where subtype=country -f geojsonseq`). `TYPE_TO_VERB` (cli.py:309-318) maps `division_area`→`boundary` but has no entry for `division`, so `download` prints no steering tip at all for this case.

Add `botmap divisions --in PLACE | --bbox … [--subtype neighborhood|locality|county|region|country] [-n N] [-f geojson|geojsonseq] [-o FILE]` to botmap/cli.py, listing divisions intersecting the area with `--geometry` to attach division_area polygons. Register `TYPE_TO_VERB["division"] = "divisions"` and teach `_suggest_verb_command` (cli.py:321-345) to translate `--where subtype=X` into `--subtype X`, so any remaining `download -t division` emits a ready-to-run replacement.

### 10. Add an `infrastructure` verb and stop telling agents download is correct  _(target: cli)_
**Evidence:** coverage_gaps.infrastructure = bike-parking-coverage, which has download_rate 1.0 across both runs (legitimate downloads — no verb exists). The download handler (cli.py:519-541) actively says "For non-transit infrastructure, download is correct."

Add `botmap infrastructure --in PLACE | --bbox … [--class bicycle_parking|bench|…] [--subtype] [-n] [-f] [-o]` to botmap/cli.py modelled on `roads` (cli.py:1218-1268), map `TYPE_TO_VERB["infrastructure"] = "infrastructure"`, and replace the "download is correct" hint with `Tip: try instead: botmap infrastructure --in "…" --class bicycle_parking`. Keep the existing transit-stop redirect to `places --category bus_stop`, which the eval shows is already working (bus-stops-cambridge: 0% download rate).

### 11. Add `building-parts` and make unknown commands that name an Overture type self-correcting  _(target: cli)_
**Evidence:** unknown_command on building-parts-detail: `botmap building_part --in "Cambridge, MA" -f geojsonseq -o cambridge_parts.jsonl` — the agent guessed the Overture type name as a verb. coverage_gaps lists both `building_part` and `building` for this question, and the run still had a 0.5 download_rate and 0.5 error_rate.

Add `botmap building-parts` (same options as `buildings`, reading type `building_part`) and set `TYPE_TO_VERB["building_part"] = "building-parts"`. Then subclass the Click group so `resolve_command` intercepts any unknown name matching an Overture type (with `_`/`-` normalization) and raises "`building_part` is a data type, not a command — run `botmap building-parts --in "Cambridge, MA" -f geojsonseq -o cambridge_parts.jsonl`", reusing `_suggest_verb_command` to echo the user's own flags back. This converts every future type-name guess into a one-line correction rather than an unknown_command.

### 12. Make the no-match error machine-readable and stop it reading as a coordinate error  _(target: hint)_
**Evidence:** 6 of the 12 ranked error clusters (pharmacies-monaco x2, reykjavik-diacritic x2, waterfront-buildings-reykjavik x2) are classified malformed_bbox_or_coords purely because `_no_match_help` (cli.py:152-179) contains the string "`containing LAT,LON`", which evals/taxonomy.py:34 fingerprints as a coordinate error. The agent gets prose with three alternatives and no concrete next command.

Change `_no_match_help` to return a structured payload emitted through `_emit_error_json(code="no_match")` on every command (not just `where`), carrying `{"query", "reason", "candidates": [ {name, region, country, bbox} ], "try": ["botmap where \"Reykjavík, IS\"", "botmap containing 64.1466,-21.9426"]}`, where `candidates` comes from a folded/fuzzy name search over the index. Phrase the human line as "No division matched … Closest names: X, Y. Run: <exact command>" and drop the bare `LAT,LON` token in favour of a filled-in example.

### 13. Make every `download` invocation emit a machine-readable replacement command  _(target: hint)_
**Evidence:** Steering already works where it exists (bus-stops-cambridge 0% download rate) but is silent where it doesn't: `download -t division` produced 3 unnecessary downloads, and the ev-charging-gap call `--json download -t division …` was also counted as bad_option — a JSON-mode agent got a grey stderr tip it never parsed.

In `download` (botmap/cli.py:496-541), after computing `suggestion`, always emit it — as `{"code": "use_verb", "suggested_command": "…", "reason": "…"}` on stdout when `ctx.obj['json']` is set, and as the current grey stderr tip otherwise — and cover the fallthrough case (no `TYPE_TO_VERB` entry) with `"reason": "no convenience verb for this type"` so the absence is explicit rather than silent. Once `divisions`, `infrastructure`, and `building-parts` exist, every type in `get_all_overture_types()` has a verb, so add a test asserting `TYPE_TO_VERB` covers all of them.

### 14. Lead the skill with a type→verb table and fix the `at --category` example  _(target: skill)_
**Evidence:** botmap/data/skill.md documents `at … --category pharmacy` (recipe 7) which does not exist, never names `division`, `infrastructure`, or `building_part`, and its troubleshooting flow says only "don't jump straight to `download`" without saying what to use instead — matching the three coverage_gaps and the two unnecessary_download clusters.

In botmap/data/skill.md: (1) add a table directly under "When to reach for this CLI" mapping every Overture type to its verb — place→`places`, building→`buildings`, building_part→`building-parts`, segment→`roads`, address→`addresses`, water→`water`, land_use→`landuse`, infrastructure→`infrastructure`, division→`divisions`, division_area→`boundary` — headed "You never need `download`; if you reach for it, you are missing a verb"; (2) add recipes for bike parking (`infrastructure --in "Cambridge, MA" --class bicycle_parking`), neighbourhoods in a bbox (`divisions --bbox … --subtype neighborhood`), and building parts; (3) correct recipe 7 once `--category` lands on `at`, and add "`--json` works before or after the subcommand" to the Self-discovery section.

### 15. Document the flag vocabulary as one grid in README/SPEC and expose examples in `capabilities`  _(target: docs)_
**Evidence:** 7 of 12 ranked clusters are bad_option, each an agent transferring a flag it learned on one command to another (`--category` onto `at`, `--street` onto `count`, `-t building` onto `categories`, `-o` onto `where`, `--json` onto any verb). `botmap --json capabilities` — the documented self-discovery path (skill.md "Self-discovery") — returns params but no worked example per command.

Add an `examples: list[str]` field to each Click command via `context_settings`/a small decorator, surface it in `_describe_command` (botmap/cli.py:284-290) so `botmap --json capabilities` returns a copy-pasteable invocation per command, and add a matching "flag compatibility grid" (rows = commands, columns = --in/--bbox/--category/--class/--street/--where/-n/-f/-o/--json) to README.md and SPEC.md. Add a test that every flag shown in botmap/data/skill.md examples exists on the command it is shown with, so the `at --category` class of drift cannot recur.

