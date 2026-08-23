# Orchestrator handover — agenteval run

Updated: 2026-08-21T16:33Z

## Current phase

Following `docs/plan.md` exactly.

Completed:
- Phase 0a: `claude -p` invocation now includes `--setting-sources project`.
- Phase 0a probes: project-scoped `botmap` skill sentinel loaded; normal `hospitals-rhode-island` question completed through Claude interactive mode billed via OpenRouter.
- Phase 1: `autoresearch/agenteval/contract.py` landed with record-v2 schema, class derivation, validation, JSON class `null` for clean calls, and attempt-level verdicts for quota/environment failures.
- Phase 2 components: Arm A/B/C implemented minimal `sabotage.py`, `explain.py`, `agent_side.py`, `probe.py`, `taxonomy.py`, `score.py` and tests.
- Phase 3 zero-spend pass over retained baseline attempts produced `experiments/agenteval-baseline-noise-run1-distribution.json`.
- Phase 4 measurement run started: unchanged botmap `3009509`, 30 questions × 2 repeats, no optimiser.

## Commits made

- `2911c1f Add agent evaluator contract and taxonomy`
- `e84e248 Wire record-v2 artifacts for retained attempts`
- `44c943e Show measurement progress on dashboard`

## Running background measurement

Run directory:

```text
experiments/runs/agenteval-measurement-3009509/
```

Files:

```text
pid
run.log
summary.json
progress.jsonl
attempts/<question>__r<repeat>/{commands.jsonl,transcript.jsonl,claude-stderr.log,record-v2.json}
```

Check:

```bash
cd /Users/priyangapkini/nilenso/ai-playground/autoresearch
ps -p $(cat experiments/runs/agenteval-measurement-3009509/pid) -o pid,etime,command
cat experiments/runs/agenteval-measurement-3009509/summary.json
tail -f experiments/runs/agenteval-measurement-3009509/run.log
```

Final measurement status:

```json
{
  "attempts_done": 60,
  "total": 60,
  "completed": 51,
  "ok": 51,
  "botmap_calls": 486,
  "cost_usd": 15.503289400000003,
  "minutes": 323.8,
  "finished": "2026-08-21T21:45:21.682677+00:00"
}
```

Retry run for the 9 incomplete/timeout attempts:

```text
experiments/runs/agenteval-measurement-3009509-retry-incomplete/
```

Retry status:

```json
{
  "attempts_done": 9,
  "completed": 2,
  "ok": 2,
  "botmap_calls": 94,
  "cost_usd": 0.30920690000000006,
  "minutes": 124.9,
  "finished": "2026-08-23T13:39:41.214499+00:00",
  "successful_replacements": [
    "residential-share-cambridge__r2",
    "which-admin-areas__r2"
  ]
}
```

Post-run probe enrichment completed for both original and retry runs. Main summary files:

```text
experiments/runs/agenteval-measurement-3009509/agenteval-summary.json
experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json
experiments/runs/agenteval-measurement-3009509-retry-incomplete/agenteval-summary.json
```

Combined class histogram with successful retries layered over original, after repairing the MA/MT entity-probe false positive:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2},
  "agent_side_counts": {}
}
```

Important correction: the initial `c-wrong-entity` bucket was an instrument bug. The entity probe treated `MA` and `MT` as ISO country codes before recognizing valid US state abbreviations (`US-MA`, `US-MT`). Fixed in `89acc62`; stale retry records repaired by `repair_us_state_entity_false_positives`.

## Dashboard

URL:

```text
http://localhost:8765/
```

Dashboard now includes a `Phase 4 measurement run` card reading `summary.json`.

Restart if needed:

```bash
old=$(lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null || true)
[ -n "$old" ] && kill $old
cd /Users/priyangapkini/nilenso/ai-playground/autoresearch/tools/dashboard
nohup python3 dashboard.py --port 8765 > /tmp/autoresearch-dashboard.log 2>&1 &
```

## Arm sessions

Herdr Pi replacements:

- `pi-arm-a` tab `w2:t1A`, pane `w2:p1K`
- `pi-arm-b` tab `w2:t1B`, pane `w2:p1M`
- `pi-arm-c` tab `w2:t1C`, pane `w2:p1N`

They reported READY after implementing their minimal Phase 2 components. Herdr may still show `working`; their visible output is READY.

## Decisions already received from Priyanga

- Spend the two Phase 0a probe calls: yes.
- record-v2 clean calls: JSON `"class": null`.
- Fixture sources: preserve old Arm A notes into autoresearch first; then use them as fixture evidence. `experiments/arm-a/notes/findings.md` already exists and is identical to the old untracked source.
- C1 candidate identity: not decided; do not assume `99d993f` vs `9a2496d` vs fresh rebuild.
- Ignored-hint detection: strict boolean plus richer detail/window.
- Quota failures: attempt-level verdict in contract.
- Exit-0 `did you mean`: preserve guided recovery path; if agent ignores it, record agent-side failure detail.

## Next actions

1. Keep polling measurement and dashboard.
2. When the Phase 4 run finishes, compute class histogram from its `record-v2.json` files.
3. Check saturation prediction: whether old-perfect questions now fail due to class C.
4. Write/update `docs/agent-friendly-cli.md` with BEFORE traces only where evidence exists; do not claim confirmation until paired before/after experiments.
5. Bring C1 identity back to Priyanga before any paired experiment using that candidate.

## Guardrails

- Do not touch `botmap/evals/`.
- Do not resume optimiser/GEPA until phases 1–5 gates are complete.
- Do not tune weights before reading the Phase 4 distribution.
- Keep global Claude `botmap` skill disabled unless Priyanga explicitly restores it.
