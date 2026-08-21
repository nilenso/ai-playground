# Agent-Usability Eval Report

Run: `4`

Total runs scored: **40**
Total cost: **$10.09** · tokens: **11,671,365** · wall-clock: **68.8 min**

## Per-question rates

| Question | Tier | Runs | Download | Unnecessary DL | Error | Completed | Avg cmds | Avg $ | Avg tokens | Avg s |
|---|---|---|---|---|---|---|---|---|---|---|
| address-points-luxembourg | 2 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.206 | 160,636 | 97.5 |
| asian-restaurants-rollup-vancouver | 2 | 2 | 0% | 0% | 0% | 100% | 6.0 | $0.372 | 472,332 | 107.5 |
| buildings-monaco | 1 | 2 | 0% | 0% | 100% | 100% | 4.0 | $0.262 | 334,750 | 37.6 |
| busstops-coffee-williamsburg | 5 | 2 | 50% | 50% | 100% | 100% | 11.5 | $0.323 | 484,660 | 259.5 |
| cafes-cambridge-ma | 1 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.298 | 336,388 | 94.7 |
| category-tattoo-near-me | 2 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.131 | 63,677 | 5.1 |
| coffee-brooklyn-count | 1 | 2 | 0% | 0% | 0% | 100% | 1.5 | $0.141 | 133,496 | 20.3 |
| containing-point | 3 | 2 | 0% | 0% | 0% | 100% | 0.0 | $0.162 | 175,822 | 135.0 |
| hardware-near-bikepaths-alameda | 5 | 2 | 0% | 0% | 0% | 100% | 5.0 | $0.567 | 1,035,712 | 589.3 |
| high-confidence-places-malta | 2 | 2 | 0% | 0% | 50% | 100% | 5.0 | $0.475 | 409,751 | 59.0 |
| hospitals-count-rhode-island | 1 | 2 | 0% | 0% | 0% | 100% | 4.0 | $0.301 | 334,700 | 192.8 |
| landuse-brooklyn | 4 | 2 | 50% | 0% | 0% | 100% | 2.0 | $0.169 | 193,454 | 32.3 |
| point-query-rome | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.196 | 136,944 | 81.9 |
| pois-near-point | 3 | 2 | 0% | 0% | 50% | 100% | 2.0 | $0.254 | 297,358 | 67.4 |
| restaurant-categories-brooklyn | 2 | 2 | 0% | 0% | 0% | 100% | 2.5 | $0.225 | 282,358 | 63.2 |
| schema-introspection-places | 1 | 2 | 0% | 0% | 0% | 100% | 1.0 | $0.189 | 135,664 | 67.3 |
| starbucks-brand-seattle | 2 | 2 | 0% | 0% | 0% | 100% | 3.0 | $0.267 | 282,844 | 43.4 |
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
- **malformed_bbox_or_coords** in `high-confidence-places-malta` ×1
  - `botmap --json where Malta, MLT`
- **bad_option** in `pois-near-point` ×1
  - `botmap --json count -t place --at 40.7128,-74.0060 --radius 150`

## Coverage gaps (legitimate downloads)

- type **land_use** — wanted by: landuse-brooklyn

## Unnecessary download (agent failures)

- `busstops-coffee-williamsburg`:
  - `botmap download -t infrastructure --bbox -73.96245306396484,40.70561868286133,-73.94443780517578,40.723622497558594 --where class=bus_stop -f geojsonseq -o busstops.jsonl`

## Proposed improvements

### 1. Fix null-propagating qualifier filter that breaks every country-qualified place name  _(target: cli)_
**Evidence:** Both `malformed_bbox_or_coords` clusters are actually unresolved places: `count -t building --in "Monaco, MC"` (2 occurrences, buildings-monaco error_rate 1.0) and `where "Malta, MLT"` (high-confidence-places-malta error_rate 0.5). Reproduced locally: for a row with country='MC' and region=NULL, `pc.or_(pc.or_(country_match, region_match), region_suffix_match)` evaluates to null, so `table.filter(...)` drops it — 0 rows.

In botmap/geocoding.py:182-184 (`resolve`), replace the null-propagating `pc.or_` chain with Kleene logic: `filtered = filtered.filter(pc.fill_null(pc.or_kleene(pc.or_kleene(country_match, region_match), region_suffix_match), False))`. Country- and region-level divisions have `region = NULL`, so every `"Name, CC"` query — 'Monaco, MC', 'Malta, MT', 'Boston, US' (advertised in skill.md:35) — currently returns no match. Add regression tests in tests/test_geocoding.py for a null-region row matched by its country code.

### 2. Complete the ISO alpha-3 country table the skill already promises  _(target: cli)_
**Evidence:** `where "Malta, MLT"` errored. botmap/geocoding.py:49-94 `_COUNTRY_ALIASES` hand-lists ~45 countries; MLT, MCO, ISL-style codes for the other ~150 are absent, yet skill.md:32-33 tells the agent `"Place, CCC" (alpha-3)` is supported.

Replace the hand-maintained alpha-3 half of `_COUNTRY_ALIASES` with a generated full ISO-3166-1 alpha-3→alpha-2 map (vendor a small `botmap/data/iso3166.json` at build time or add `pycountry`), keeping the informal aliases ('UK', 'USA', 'Holland') as a separate overlay dict. In `_normalize_qualifier` (geocoding.py:122), when the qualifier is exactly 3 letters and not in the table, fall through unchanged rather than silently producing a no-match.

### 3. Stop routing bus stops to `places` — they are `infrastructure`; add a `transit` verb  _(target: cli)_
**Evidence:** busstops-coffee-williamsburg: error_rate 1.0, 11.5 avg commands, the single unnecessary_download cluster. The agent ran `download -t infrastructure --where class=bus_stop`, which cli.py:531 hard-rejects with 'Transit stops are `place` features'; it then ran `places --category bus_stop`, which returned `bad_category_value`. Verified against Overture for that exact bbox: infrastructure has class=bus_stop×93, stop×135, stop_position×60, bus_station×1; place has categories.primary=bus_stop×0.

Delete the hard `raise click.UsageError` at botmap/cli.py:531-534 and the misleading tip at cli.py:535-541 — they block the only command that works. Add a `transit` convenience verb modeled on `landuse` (cli.py:1340): `botmap transit --in/--bbox [--class bus_stop|stop|stop_position|bus_station|subway_station] [--where ...] [-n] [-f] [-o]`, mapping to type `infrastructure` with an implicit `subtype=transit` filter plus the `--class` shortcut. Register `"infrastructure": "transit"` in TYPE_TO_VERB (cli.py:310) so plain `download -t infrastructure` also suggests it.

### 4. Correct the three places the Skill asserts bus stops are POIs  _(target: skill)_
**Evidence:** The skill's own guidance produced the failing command: `places --in Williamsburg --category bus_stop` yields 0 rows (bad_category_value), while infrastructure/class=bus_stop has 93 features in the same bbox.

In botmap/data/skill.md: (1) rewrite recipe 15 (lines 183-188) to `botmap transit --in "Williamsburg, NY" --class bus_stop -f geojsonseq -o busstops.jsonl`; (2) delete the anti-pattern bullet at lines 257-259 and replace it with 'Bus stops, platforms and stop positions are `infrastructure` (subtype=transit, `class`), not places — use `transit --class bus_stop`. `place` only carries staffed transit *buildings* (train_station, bus_station, metro_station).'; (3) fix the `place` row of the schema cheatsheet (line 210) by removing the bolded **bus_stop, bus_station, train_station** and add an `infrastructure` row listing `subtype` (transit, power, pedestrian, ...) and `class`. Also update the tier-5 subtasks in evals/questions.yaml:93-96, which encode the same wrong command.

### 5. Give `count` the proximity flags it was called with  _(target: cli)_
**Evidence:** pois-near-point (error_rate 0.5, bad_option): `--json count -t place --at 40.7128,-74.0060 --radius 150` → 'No such option'. The agent correctly modeled 'count things near a point' but `count` (cli.py:776-813) only accepts --bbox/--in.

Add `--at LAT,LON` and `-radius/--radius METERS` to `count`, mutually exclusive with --bbox/--in, resolving via the existing `_parse_latlon` + `bbox_around_point(lat, lon, radius)` (cli.py:1464-1468) with `DEFAULT_RADIUS_BY_TYPE` as the default. Emit `at`/`radius` in the `--json` payload alongside `bbox`. Do the same for `places`, `buildings`, `roads`, `water`, `landuse`, `addresses` so `--at/--radius` means one thing everywhere.

### 6. `at` is missing `--category` and steals `-r` from `--release`  _(target: cli)_
**Evidence:** skill.md:136 documents `botmap at 40.7484,-73.9857 -t place --category pharmacy --radius 250 -n 10`, but `botmap at --help` shows no `--category` — following the skill verbatim produces a `bad_option` failure. Separately, `at` binds `-r` to `--radius` (cli.py:1450) while every other command binds `-r` to `--release`, so `-r 250` silently means two different things and on a verb fails inside `validate_release` with 'Release 250 is no longer available'.

In the `at` command (cli.py:1444-1462) add `--category` as a shortcut for `--where categories.primary=VAL` (same construction as `places`, cli.py:1117-1120), and change `-r, --radius` to `--radius` only, adding `-r` back to `--release` so the short flag is consistent across the CLI. Keep `-r` accepted as a hidden deprecated alias for radius for one release with a stderr deprecation note.

### 7. Zero-result hint should search other types, not just other categories  _(target: hint)_
**Evidence:** `places --category bus_stop` in Williamsburg returns 0 rows; `_suggest_categories` (cli.py:97-149) only scans `place` categories, so the agent gets 'did you mean …' with no usable alternative and burns 11.5 commands. The right answer lives in a different type (infrastructure.class=bus_stop, 93 features in that bbox).

Extend the 0-row path in `places` (cli.py:1139-1168): before suggesting near-miss categories, scan `infrastructure.class` and `segment.class` in the same bbox for an exact match on the requested value, and when found emit a ready-to-run command — `[botmap] 0 rows: no place has categories.primary='bus_stop' here, but 93 infrastructure features have class='bus_stop'. Run: botmap transit --bbox … --class bus_stop`. Apply the mirror-image hint in `roads`/`landuse`/`water` when a `--class` value matches nothing but exists on another type.

### 8. Make `download` refuse types that a verb already covers  _(target: cli)_
**Evidence:** landuse-brooklyn shows download_rate 0.5 even though the `landuse` verb exists (cli.py:1340) and cli.py:515-518 already prints a ready-to-run tip — the agent ignored it because it is a `bright_black` stderr line on an otherwise successful command. The one hard-error path in that same block (`division_area`, cli.py:510-514) has zero recorded misuse.

For every type in TYPE_TO_VERB (cli.py:310-318), promote the soft tip to the same hard `click.UsageError` used for `division_area`, with the exact replacement command produced by `_suggest_verb_command` and the escape hatch named in the message: 'run with --force (or BOTMAP_ALLOW_RAW_DOWNLOAD=1) to use the low-level path anyway'. Add the `--force` flag to `download` so human/scripted use is unbroken. This makes 'agent never needs download' enforceable rather than advisory.

### 9. Reword the no-match error so it names the failure and stops poisoning the error taxonomy  _(target: hint)_
**Evidence:** `_no_match_help` (cli.py:152-179) ends with 'Try a parent locality (city → state → country), `containing LAT,LON`, or `--bbox`.' The literal string 'LAT,LON' matches evals/taxonomy.py:36, so both unresolved-place failures ('Monaco, MC', 'Malta, MLT') were filed as `malformed_bbox_or_coords` — the top-ranked error cluster in this report is mislabeled and points at bbox parsing, which was never wrong.

Two changes. (1) cli.py:175-179: lead with the diagnosis and a runnable recovery, e.g. `No division found for 'Malta, MLT'. The qualifier 'MLT' matched no country or region. Try: botmap where "Malta" --all` and drop the bare 'LAT,LON' placeholder in favour of `botmap containing 35.9,14.4` style. (2) evals/taxonomy.py: add an `unresolved_place` label matched on 'no division found for' and check it *before* the 'lat,lon' fingerprint at line 36, so place-resolution failures are counted as their own class.

### 10. Retire the stale land_use coverage-gap annotation in the question bank  _(target: docs)_
**Evidence:** coverage_gaps reports `land_use: [landuse-brooklyn]`, but that is bookkeeping, not a real gap: evals/questions.yaml:69-72 still carries `download_is_legitimate: true` with the note 'No convenience verb for land_use; download -t land_use is correct. Coverage-gap candidate.' The `landuse` verb has existed since cli.py:1340. The run's `download -t land_use` was therefore scored as legitimate when it should have counted against the unnecessary-download metric.

In evals/questions.yaml set `download_is_legitimate: false` for landuse-brooklyn and replace the note with 'Covered by the `landuse` verb (`landuse --in "Brooklyn, US-NY" --class …`); any `download -t land_use` is a steering failure.' Then audit every remaining `download_is_legitimate: true` entry against the current TYPE_TO_VERB map (cli.py:310) and add a test in tests/test_eval_questions.py asserting that no question marks a download legitimate for a type that has a convenience verb — so this drifts loudly instead of silently.

