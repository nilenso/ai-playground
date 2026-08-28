# Agent-Usability Eval Report

Run: `2`

Total runs scored: **30**
Total cost: **$9.09** · tokens: **9,490,039** · wall-clock: **83.4 min**

## Per-question rates

| Question | Tier | Runs | Download | Unnecessary DL | Error | Completed | Avg cmds | Avg $ | Avg tokens | Avg s |
|---|---|---|---|---|---|---|---|---|---|---|
| buildings-monaco | 1 | 2 | 0% | 0% | 100% | 50% | 4.0 | $0.361 | 350,018 | 159.7 |
| busstops-coffee-williamsburg | 5 | 2 | 50% | 50% | 100% | 100% | 11.5 | $0.323 | 484,660 | 259.5 |
| cafes-cambridge-ma | 1 | 2 | 0% | 0% | 0% | 100% | 4.5 | $0.737 | 622,398 | 569.4 |
| coffee-brooklyn-count | 1 | 2 | 0% | 0% | 0% | 100% | 1.5 | $0.141 | 133,496 | 20.3 |
| containing-point | 3 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.162 | 175,822 | 135.0 |
| hardware-near-bikepaths-alameda | 5 | 2 | 0% | 0% | 0% | 100% | 5.0 | $0.567 | 1,035,712 | 589.3 |
| hospitals-count-rhode-island | 1 | 2 | 0% | 0% | 0% | 100% | 3.5 | $0.416 | 275,366 | 161.9 |
| landuse-brooklyn | 4 | 2 | 50% | 0% | 0% | 100% | 2.0 | $0.169 | 193,454 | 32.3 |
| point-query-rome | 1 | 2 | 0% | 0% | 0% | 100% | 2.0 | $0.382 | 190,048 | 243.9 |
| pois-near-point | 3 | 2 | 0% | 0% | 50% | 100% | 2.0 | $0.254 | 297,358 | 67.4 |
| restaurant-categories-brooklyn | 2 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.225 | 282,358 | 63.2 |
| schema-introspection-places | 1 | 2 | 0% | 0% | 0% | 100% | 2.0 | $0.302 | 139,192 | 88.1 |
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

### 1. Fix null-propagating OR in geocoding.resolve() — "Monaco, MC" and every country-level place resolves to nothing  _(target: cli)_
**Evidence:** buildings-monaco: error_rate 1.0 (2/2 runs), completion_rate 0.5, avg 4.0 commands. Both failing calls are `--json count -t building --in "Monaco, MC"`. Reproduced locally: `resolve("Monaco")` returns 12 divisions (top = Monaco, region, MC) but `resolve("Monaco, MC")`, `resolve("Monaco, MCO")` and `resolve("Monaco, Monaco")` all return 0. Root cause is botmap/geocoding.py:179-184: the qualifier mask is built with `pc.or_(pc.or_(country_match, region_match), region_suffix_match)`, and `pc.or_` is NOT Kleene — `true OR null == null`, so any division whose `region` is null is dropped even when `country` matches exactly. 59,164 of 4,655,003 index rows (1.27%) have a null region: every country, plus city-states and country-level regions (Monaco, Singapore, Vatican, Hong Kong, Macau). The skill explicitly advertises the `"Place, CC"` form (skill.md:32-35), so the agent follows documented syntax straight into a dead end.

In botmap/geocoding.py:179-184, replace both `pc.or_` calls with `pc.or_kleene`, or equivalently wrap the combined mask in `pc.fill_null(mask, False)` before `filtered.filter(...)`. Note `pc.ends_with` also returns null on a null region, so the fill_null must be applied to the final mask, not to the individual comparisons. Add regression tests in tests/test_geocoding.py asserting a non-empty result for `resolve("Monaco, MC")`, `resolve("Monaco, MCO")`, `resolve("Singapore, SG")`, and `resolve("Vatican City, VA")`, and assert that a country-subtype row with `region=None` survives qualifier filtering — this is the class of bug the current tests miss because every fixture place is a US city with a populated region.

### 2. Stop the eval taxonomy mislabeling place-resolution failures as malformed coordinates  _(target: docs)_
**Evidence:** The #1 ranked error cluster is `malformed_bbox_or_coords` (count 2) for `count -t building --in "Monaco, MC"` — a call that passes no bbox and no coordinates at all. The failure is `_no_match_help` (botmap/cli.py:152-179), whose text ends `... Use that, \`containing LAT,LON\`, or \`--bbox\`.`; evals/taxonomy.py:36 matches `"lat,lon" in low` and labels it malformed_bbox_or_coords. The CLI's own recovery hint is what triggers the misclassification, so the highest-ranked cluster in this report points at the wrong subsystem and no amount of bbox-parsing work would fix it.

In evals/taxonomy.py, gate the coordinate/bbox patterns on the call actually carrying such an argument: before the line-36 check, `if not any(tok in call.argv for tok in ('--bbox',)) and call.subcommand not in ('at','containing')`, skip to the next rule. Add a new label above it: `if "no division found for" in low: return "unresolvable_place"`. Also tighten the match to the emitting sites rather than prose — check for `"requires exactly 4 values"`, `"must be numbers"`, `"must be between"`, `"must be less than or equal"` (BboxParamType, cli.py:363-410) and the `_parse_latlon` message (cli.py:58) instead of the bare `"lat,lon"` substring. Add a fixture case to tests/test_eval_synthesize.py covering a `--in`-only failure so the classifier can't regress back to the coordinate bucket.

### 3. Give `count` proximity flags (and `at` a count mode) so "how many near X" never dead-ends  _(target: cli)_
**Evidence:** ranked_error_clusters: `bad_option` on `--json count -t place --at 40.7128,-74.0060 --radius 150` (pois-near-point, error_rate 0.5). `count` (cli.py:776-813) accepts only `--bbox`/`--in`; `at` (cli.py:1444) is the only proximity-aware command and it streams features with no way to get a number. The agent applied the skill's own "count before pulling" rule (skill.md:64) to the skill's own "near a point → use `at`" rule (skill.md:79-82) and the two are not composable, costing a wasted command.

In botmap/cli.py `count`, add `@click.option('--at', 'latlon', type=str, help="'LAT,LON' — count features near a point; pair with --radius.")` and `@click.option('--radius', type=int, default=None, help='Meters; requires --at. Defaults per type.')`. Parse with the existing `_parse_latlon`, derive the bbox with `bbox_around_point` exactly as `at` does, and reject `--at` alongside `--bbox`/`--in` with the existing mutual-exclusion UsageError. Because `count` counts rows in a bbox rather than a circle, include `"shape": "bbox_around_point"` and the derived `"bbox"` in the `--json` payload so the agent knows the number is an upper bound. Symmetrically add `@click.option('--count', 'count_only', is_flag=True)` to `at` (cli.py:1444) that prints `{"count": N, "radius_m": R}` after the haversine filter instead of writing features — that number is the exact in-radius count.

### 4. Make `at` accept the same filter/limit flags as the verbs — the skill documents flags it does not have  _(target: cli)_
**Evidence:** skill.md:136 tells the agent to run `botmap at 40.7484,-73.9857 -t place --category pharmacy --radius 250 -n 10`, but `botmap at --help` shows no `--category` — that documented recipe fails with `No such option: --category` (the same `bad_option` class already costing commands in pois-near-point and busstops-coffee-williamsburg). `at` also lacks the `--limit` alias that skill.md:73 claims covers it, and its `-r` is `--radius` while `-r` on every other command (count/sample/places/buildings/roads/water/landuse/categories/schema) is `--release` — a silent-wrong-answer trap, since `at -r 2026-07-22.0` is parsed as a 2026-kilometre radius, not a release.

In botmap/cli.py `at` (1444-1461): add `@click.option('--category', required=False, type=str, help='Shorthand for --where categories.primary=VALUE (place only).')` appending the same `ParsedFilter(key='categories.primary', op='=', value=category)` that `places` builds at cli.py:1117-1120; add `'--limit'` as a second name on the existing `-n` option (`@click.option('-n', '--limit', 'n', ...)`) so `-n`/`--limit` work uniformly across `sample`, `at`, and every verb. Change the radius option to `@click.option('--radius', '-r', type=int, help='Radius in meters. NOTE: -r here is radius, not release; use --release.')` and add a `validate_release`-style callback on `--radius` that raises a UsageError when the value looks like a release string (matches `^\d{4}-\d{2}-\d{2}`), pointing at `--release`.

### 5. Turn the `download -t infrastructure` transit steer into a transparent redirect instead of an error  _(target: cli)_
**Evidence:** unnecessary_download + `bad_option` cluster, busstops-coffee-williamsburg (error_rate 1.0, avg_commands 11.5 — the most expensive question in the suite): `download -t infrastructure --bbox … --where class=bus_stop -f geojsonseq -o busstops.jsonl` hits the hard `raise click.UsageError(...)` at cli.py:531-534. The steering text is correct and the agent follows it, but the call exits nonzero, is scored as an error, and burns a turn to re-issue an equivalent command. The same is true of the `division_area` hard error at cli.py:510-514.

In botmap/cli.py:519-541, replace the transit `UsageError` with a redirect: print `click.secho('[botmap] Transit stops are `place` features, not infrastructure — running `botmap places --category <cls> …` instead.', fg='yellow', err=True)` then `ctx.invoke(places, bbox=bbox, in_place=in_place, category=<the class= value>, where_exprs=tuple(remaining exprs), limit=None, output_format=output_format, output=output, release=release, json_no_op=False)` and return with exit 0 (add `@click.pass_context` to `download`). Do the same at cli.py:510-514 for `division_area`, invoking `boundary`. The agent gets the data it asked for on the first call, still reads the correct steer on stderr, and the error class disappears from the trace.

### 6. Hard-stop `download` whenever a convenience verb covers the type, with `--force` as the escape hatch  _(target: cli)_
**Evidence:** landuse-brooklyn: download_rate 0.5 — one of two runs ran `download -t land_use --bbox … -f geojsonseq -o …` even though `landuse` (cli.py:1322) takes exactly those flags and TYPE_TO_VERB (cli.py:310-318) already maps `land_use → landuse`. The only deterrent today is the `fg='bright_black'` stderr tip at cli.py:515-518, which is advisory and was ignored. As long as `download` succeeds for covered types, the stated goal — the agent never needs `download` — cannot be enforced, only hoped for.

In botmap/cli.py:504-518, after computing `suggestion = _suggest_verb_command(...)`, escalate the tip to `raise click.UsageError(f"`download -t {type_}` is the low-level escape hatch and the covering command is:\n  {suggestion}\nRun that instead, or re-run with --force if you truly need the raw path.")` unless `--force` is set. Add `@click.option('--force', is_flag=True, default=False, help='Bypass the convenience-verb redirect.')` to `download`, and honor `BOTMAP_FORCE_DOWNLOAD=1` for scripted callers. `_suggest_verb_command` already folds `categories.primary=`/`class=` into `--category`/`--class` and passes the rest through as `--where`, which every verb accepts, so the suggestion is lossless for all seven covered types. Types with no TYPE_TO_VERB entry keep working unchanged.

### 7. Correct the skill's claim that `bus_stop` is a populated place category  _(target: skill)_
**Evidence:** ranked_error_clusters: `bad_category_value` on `places --bbox -73.96,40.70,-73.94,40.72 --category bus_stop -f geojsonseq -o busstops.jsonl` (busstops-coffee-williamsburg, 11.5 avg commands, the suite's most expensive question). The agent did exactly what skill.md:183-188 (recipe 15), the cheatsheet at skill.md:210 (which **bolds** bus_stop, bus_station, train_station) and the anti-pattern at skill.md:257-259 instruct, and got 0 rows. Three separate places in the skill assert the data exists; none tells the agent to verify first.

Rewrite recipe 15 in botmap/data/skill.md to lead with verification: retitle to `### 15. Transit stops (sparse — verify before relying on them)` and make the first command `botmap --json categories -t place --in "<place>" --top 100 | jq '.[] | select(.value|test("bus|transit|station"))'`, followed by `# If nothing comes back, the release has no transit POIs for this area — say so and stop. bus_station/train_station are terminals, not stops, and `download -t infrastructure` does not contain them either.` Change the cheatsheet cell at skill.md:210 to `categories.primary (hotel, restaurant, cafe, hospital, …; transit values such as bus_stop are sparse or absent in many regions — confirm with `categories` first)`, dropping the bold. Keep the skill.md:257-259 anti-pattern's "not infrastructure" steer but strike the implication that the data is there.

### 8. Make the zero-rows hint distinguish "misspelled" from "absent from this release"  _(target: hint)_
**Evidence:** The `places` zero-result hint (cli.py:1139-1168) emits `Did you mean: …?` whenever `_suggest_categories` returns anything, and evals/taxonomy.py:24 classifies that string as `bad_category_value`. For `--category bus_stop` the value was not misspelled — it is genuinely absent — so the hint sent the agent hunting a near-match that does not exist, contributing to 11.5 avg commands on busstops-coffee-williamsburg. The `--class` verbs (`roads` cli.py:1235, `water` cli.py:1287, `landuse` cli.py:1340) print nothing at all on 0 rows, so a wrong `--class` value gives the agent no signal whatsoever.

In botmap/cli.py:1150-1168, have `_suggest_categories` (cli.py:97-149) return `(value, score)` pairs and only phrase the hint as `Did you mean: X?` when the top score reflects a genuine string near-match (difflib ratio ≥ 0.7). Otherwise emit an absence-framed message: `[botmap] 0 rows. categories.primary='bus_stop' is a valid schema value but has no features in this bbox. Present here instead: cafe, restaurant, … . Check once at a wider scope with `count -t place --in "<parent>" --where categories.primary=bus_stop`; if that is also 0, the release does not carry this category — report that rather than searching further.` Extract that block into a shared `_zero_rows_hint(field, target, type_, bbox, release)` helper and call it from the `--class` verbs too, keyed on `class` instead of `categories.primary`.

### 9. Retire the `download` recipe from the skill and add an explicit never-use-download rule  _(target: skill)_
**Evidence:** botmap/data/skill.md:156-162 recipe 11 is titled "Compose where + download" and is the only worked example of feeding a resolved bbox into a data command — so an agent needing the bbox→data pattern copies `download` verbatim. This is the pattern behind the landuse-brooklyn download (download_rate 0.5) and the busstops `download -t infrastructure` attempt. The anti-pattern list at skill.md:263-265 says only to "prefer" the verbs, which reads as a style preference rather than a rule.

Retitle skill.md recipe 11 to `### 11. Compose where + a verb` and replace the body with `BBOX=$(botmap --json where "Berlin" | jq -r '.bbox | join(",")')` / `botmap places --bbox "$BBOX" --category hotel -f geojsonseq -o berlin_hotels.jsonl`, plus the note `Every verb takes --bbox, so you never need `download` to consume a computed bbox.` Then add a rule immediately after the trigger list (skill.md:27) titled **Never run `download`** with the full mapping `place→places, segment→roads, building→buildings, address→addresses, water→water, land_use→landuse, division_area→where … --geometry, transit stops→places --category, near-a-point→at`, and the fallback line: `If none of those fit, run `botmap --json capabilities` and pick a command — `download` is the raw escape hatch and now requires --force.` Ensure no remaining code block in the file invokes `download`.

### 10. Fix the stale land_use question metadata and derive coverage gaps from TYPE_TO_VERB  _(target: docs)_
**Evidence:** coverage_gaps reports `land_use: [landuse-brooklyn]` as a legitimate download, but botmap/cli.py:310-318 has mapped `land_use → landuse` for some time and the verb (cli.py:1322) accepts the exact `--bbox -f -o` flags the run used. The cause is evals/questions.yaml:66-72, which still carries `download_is_legitimate: true` and the note "No convenience verb for land_use; download -t land_use is correct"; evals/score.py:69 trusts that flag verbatim (`unnecessary_download = download_used and not legit`). The harness is under-counting avoidable downloads on exactly the metric being optimized, and would score a regression as a pass.

Set `download_is_legitimate: false` in evals/questions.yaml:69 and rewrite the note to "`landuse --in 'Brooklyn, US-NY'` covers this; any `download -t land_use` is avoidable." In evals/score.py, stop treating the YAML flag as the sole authority: import `TYPE_TO_VERB` from `botmap.cli` and mark a download unnecessary whenever its `-t` value is a key of that map and every other flag it carried is one the target verb accepts (`--bbox`, `--in`, `--where`, `-f`, `-o`, `-n`), regardless of the YAML flag. Reserve `coverage_gaps` for types with no TYPE_TO_VERB entry (infrastructure, division, land_cover, …), which is what the field is meant to surface. Add a case to tests/test_eval_synthesize.py asserting that a `download -t land_use --bbox …` call scores as `unnecessary_download`, and re-run the 30-run suite so the land_use entry moves out of coverage_gaps.

