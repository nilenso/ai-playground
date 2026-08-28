# Arm relaunch snapshot

Captured: 2026-08-24T05:50:38Z

## Git
51a609c Exclude evaluator-adjacent tests from full repo optimizer
7ce1b31 Keep evaluator files out of full repo optimizer edits
686cce1 Allow full repo optimizer context and edits
cc75a95 Record count wrong-column paired experiment
9ed2a19 Probe category vocabulary from CLI listings
17e4c47 Update handover with truncation experiment
22fab9b Record categories truncation paired experiment
16a9b4c Record corrected evaluator distribution

## Shared repo status
 M autoresearch/autoresearch/agenteval/score.py
 M autoresearch/autoresearch/baseline.py
 M autoresearch/autoresearch/evaluator.py
 M autoresearch/tests/test_agenteval_score.py
?? .DS_Store
?? .claude/worktrees/autoresearch-prompt/
?? .idea/.gitignore
?? .idea/.name
?? .idea/ai-playground.iml
?? .idea/autoresearch.iml
?? .idea/dictionaries/project.xml
?? .idea/inspectionProfiles/profiles_settings.xml
?? .idea/modules.xml
?? .idea/sift.iml
?? .idea/vcs.xml
?? .vscode/settings.json
?? autoresearch/experiments/orchestrator/subagent-relaunch-20260824T055038Z/SNAPSHOT.md
?? autoresearch/tests/test_evaluator_agenteval.py
?? autoresearch/tests/test_optimizer_gate.py
?? autoresearch/tools/dashboard/lever-history

## Herdr arms
pi-arm-a idle w2:p1K w2:t1A /Users/priyangapkini/nilenso/ai-playground/autoresearch
pi-arm-b idle w2:p1M w2:t1B /Users/priyangapkini/nilenso/ai-playground/autoresearch
pi-arm-c working w2:p1N w2:t1C /Users/priyangapkini/nilenso/ai-playground/autoresearch

## Running arm processes
54516    01:35:15 /bin/bash -c cd /Users/priyangapkini/nilenso/ai-playground/autoresearch && nohup uv run python /tmp/arm_a_full_agenteval.py > experiments/runs/arm-a-new-evaluator-full-screening-driver.log 2>&1 & echo $! > experiments/runs/arm-a-new-evaluator-full-screening-driver.pid && echo started $(cat experiments/runs/arm-a-new-evaluator-full-screening-driver.pid)
54518    01:35:15 uv run python /tmp/arm_a_full_agenteval.py
54520    01:35:15 /Users/priyangapkini/nilenso/ai-playground/autoresearch/.venv/bin/python3 /tmp/arm_a_full_agenteval.py
54610    01:34:46 /bin/bash -c cd /Users/priyangapkini/nilenso/ai-playground/autoresearch\012launch_log="experiments/runs/arm-b-prompt-launch-$(date +%Y%m%d-%H%M%S).log"\012(\012  set -a\012  source .env\012  set +a\012  BOTMAP_REPO=/Users/priyangapkini/workspace/ar-b-new/botmap \\012    uv run python -m autoresearch.optimize \\012      --lever prompt \\012      --budget 60 \\012      --keep-runs\012) > "$launch_log" 2>&1 &\012pid=$!\012echo "PID=$pid"\012echo "LOG=$launch_log"\012sleep 5\012if ps -p "$pid" >/dev/null; then\012  echo "STATUS=running"\012else\012  echo "STATUS=exited"\012fi\012printf 'RECENT_RUNS='; find experiments/runs -maxdepth 1 -type d -name 'prompt-3009509-*' -print | sort | tail -3 | tr '\n' ' '; echo\012echo '--- log tail ---'\012tail -80 "$launch_log"
54612    01:34:46 uv run python -m autoresearch.optimize --lever prompt --budget 60 --keep-runs
54613    01:34:46 /Users/priyangapkini/nilenso/ai-playground/autoresearch/.venv/bin/python3 -m autoresearch.optimize --lever prompt --budget 60 --keep-runs
68414       17:33 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap --json containing 42.36647554,-71.10515453
70689       04:21 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap --json containing 42.3635229,-71.0696298
70880       03:39 uv run python -m autoresearch.optimize --lever tool --all-files --full-repo-context --budget 60 --keep-runs
70882       03:39 /Users/priyangapkini/nilenso/ai-playground/autoresearch/.venv/bin/python3 -m autoresearch.optimize --lever tool --all-files --full-repo-context --budget 60 --keep-runs
71300       02:00 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap roads --bbox -73.96245306396484,40.70561868286133,-73.94443780517578,40.723622497558594 --where class in [motorway,primary,secondary,tertiary,residential,living_street,unclassified] -f geojsonseq -o williamsburg_roads.jsonl
71561       00:45 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap addresses --in Cambridge, MA --street Massachusetts -n 20
71594       00:35 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap --json sample -t division --where subtype=country --bbox 5.7,49.4,6.6,50.2 -n 5
71627       00:17 python3 /Users/priyangapkini/nilenso/ai-playground/autoresearch/autoresearch/shim/botmap --json count -t address --in Cambridge, MA --where street=Massachusetts Ave

## Arm A runs
### experiments/runs/arm-a-new-evaluator-count-zero-hint-9a2496d
{'name': 'arm-a-new-evaluator-count-zero-hint-9a2496d', 'branch': None, 'commit': None, 'attempts_done': 21, 'attempts_total': 60, 'completed': 21, 'ok': 21, 'botmap_calls': 85, 'cost_usd': 4.0696388, 'finished': None, 'minutes': 86.6}
[arm-a-new-evaluator-count-zero-hint-9a2496d] tattoo-category-discovery__r1
[arm-a-new-evaluator-count-zero-hint-9a2496d] tattoo-category-discovery__r2
[arm-a-new-evaluator-count-zero-hint-9a2496d] malta-highways-absent-class__r1
[arm-a-new-evaluator-count-zero-hint-9a2496d] malta-highways-absent-class__r2
[arm-a-new-evaluator-count-zero-hint-9a2496d] starbucks-name-vs-brand__r1
[arm-a-new-evaluator-count-zero-hint-9a2496d] starbucks-name-vs-brand__r2
[arm-a-new-evaluator-count-zero-hint-9a2496d] tall-buildings-cambridge__r1
[arm-a-new-evaluator-count-zero-hint-9a2496d] tall-buildings-cambridge__r2
### experiments/runs/arm-a-new-evaluator-preflight-20260824T041555Z
{'name': None, 'branch': None, 'commit': None, 'attempts_done': None, 'attempts_total': None, 'completed': None, 'ok': None, 'botmap_calls': None, 'cost_usd': None, 'finished': None, 'minutes': None}

## Arm B prompt run
experiments/runs/prompt-3009509-1787544952
6.1M	experiments/runs/prompt-3009509-1787544952
# 12. Cache
botmap --json cache info    # is the divisions index current?
botmap cache build          # rebuild
```

## Anti-patterns

- **Never query globally.** Always `--in` or `--bbox`; global pulls are 100s of GB.
- **Never report 0 without running the unfiltered count** (see the zero-results
  protocol above). Confidently answering "none" off a bad filter is the worst
  failure here.
- **Don't guess field paths** — `schema -t TYPE`. Don't filter by
  `addresses.*` / country fields; scope geographically.
- **Don't parse human stdout** — use `--json` for metadata commands.
- **Don't ignore the `[botmap]` stderr warning** — it tells you which Boston
  you got; re-run with `"Boston, US-MA"` if wrong.
- **Bus stops and transit points are places**: `places --category bus_stop`.
- **Boundaries come from `where … --geometry`**, not `download -t division_area`.
- **Prefer convenience verbs over `download -t TYPE`**; prefer `--where`
  pushdown over post-filtering GeoJSON.
GEPA Optimization:   0%|          | 0/60 [00:00<?, ?rollouts/s]GEPA Optimization:   8%|8         | 5/60 [33:55<6:13:12, 407.13s/rollouts]/Users/priyangapkini/nilenso/ai-playground/autoresearch/.venv/lib/python3.11/site-packages/gepa/core/engine.py:742: UserWarning: cloudpickle is not installed; falling back to standard pickle. Install it with: pip install gepa[full]  or  pip install cloudpickle
  state.save(self.run_dir, use_cloudpickle=self.use_cloudpickle)

## Arm C valid run
pid file: experiments/runs/arm-c-full-repo-no-evaluator.pid
70880
[oa]   botmap/__init__.py
[oa]   botmap/__main__.py
[oa]   botmap/cache.py
[oa]   botmap/changelog.py
[oa]   botmap/cli.py
[oa]   botmap/core.py
[oa]   botmap/data/__init__.py
[oa]   botmap/data/skill.md
[oa]   botmap/examples/geopandas_example.ipynb
[oa]   botmap/filters.py
[oa]   botmap/geocoding.py
[oa]   botmap/intents.py
[oa]   botmap/introspection.py
[oa]   botmap/models.py
[oa]   botmap/releases.py
[oa]   botmap/skill_installer.py
[oa]   botmap/state.py
[oa]   botmap/writers.py
[oa]   designing_cli_interfaces_for_data_products.md
[oa]   docs/automated-improvements/progress_summary.md
[oa]   docs/automated-improvements/report-example-01.md
[oa]   docs/automated-improvements/report-example-02.md
[oa]   docs/automated-improvements/report-example-03.md
[oa]   docs/superpowers/plans/2026-05-11-agent-friendly-cli.md
[oa]   docs/superpowers/plans/2026-05-28-agent-usability-eval.md
[oa]   docs/superpowers/specs/2026-05-11-agent-friendly-cli-design.md
[oa]   docs/superpowers/specs/2026-05-28-agent-usability-eval-design.md
[oa]   justfile
[oa]   pyproject.toml
[oa]   pytest.ini
[oa]   tests/__init__.py
[oa]   tests/test_cache.py
[oa]   tests/test_cache_integration.py
[oa]   tests/test_changelog.py
[oa]   tests/test_cli_at.py
[oa]   tests/test_cli_cache.py
[oa]   tests/test_cli_capabilities.py
[oa]   tests/test_cli_categories.py
[oa]   tests/test_cli_containing.py
[oa]   tests/test_cli_count.py
[oa]   tests/test_cli_download.py
[oa]   tests/test_cli_gers.py
[oa]   tests/test_cli_install_skill.py
[oa]   tests/test_cli_integration.py
[oa]   tests/test_cli_intents_addresses.py
[oa]   tests/test_cli_intents_buildings.py
[oa]   tests/test_cli_intents_landuse.py
[oa]   tests/test_cli_intents_places.py
[oa]   tests/test_cli_intents_roads.py
[oa]   tests/test_cli_intents_water.py
[oa]   tests/test_cli_introspection.py
[oa]   tests/test_cli_json.py
[oa]   tests/test_cli_releases.py
[oa]   tests/test_cli_sample.py
[oa]   tests/test_cli_schema.py
[oa]   tests/test_cli_verb_limit.py
[oa]   tests/test_cli_where.py
[oa]   tests/test_copy.py
[oa]   tests/test_core.py
[oa]   tests/test_filters.py
[oa]   tests/test_geocoding.py
[oa]   tests/test_gers.py
[oa]   tests/test_intents.py
[oa]   tests/test_introspection.py
[oa]   tests/test_main.py
[oa]   tests/test_models.py
[oa]   tests/test_releases.py
[oa]   tests/test_skill_installer.py
[oa]   tests/test_skill_resource.py
[oa]   tests/test_state.py
[oa]   tests/test_writers.py
[oa]   uv.lock
[oa] GEPA changes one of them per round, so each change stays attributable
[oa] warning: ~0 evaluations per file. GEPA spreads its budget evenly, so a wide file list with a small budget finds little. Raise --budget or narrow --files.
[oa] 25 questions to learn from, 5 held back to check
[oa] reusing the yardstick measured earlier for 3009509
[oa] starting from the current files (19693 lines in total)
[oa] budget: 60 evaluations (each is ~2 questions asked)
[oa] full repo context enabled (549,453 chars)
GEPA Optimization:   0%|          | 0/60 [00:00<?, ?rollouts/s]latest tool dir: experiments/runs/tool-3009509-1787550419
4.0K	experiments/runs/tool-3009509-1787550419
GEPA Optimization:   0%|          | 0/60 [00:00<?, ?rollouts/s]