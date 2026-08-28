# Arm B (prompt lever) — handover

Paused 2026-08-21. Nothing spending. Work committed as `3f3da75` (not stashed).

## 1. Done and verified

Verified = ran it, not believed it. All code in commit `3f3da75`
("Add. WIP arm-b preflight guards, openrouter path, baseline retention").

| Thing | Where | How verified |
|---|---|---|
| Shared baseline | `experiments/baselines/3009509.json` | 30/30, 0 skipped, 0 quota failures; correctness mean 0.957, median 1.000, min 0.60, no zeros; wallclock mean 142s/median 95s/max 353s; tokens mean 479k. Matches orchestrator's independent read exactly. |
| 60 raw attempts | `experiments/runs/baseline-noise-run1-3009509/attempts/` | counted; all 1136 model records read `claude-sonnet-5` |
| Release guard | `autoresearch/config.py` `_check_baseline_release` | fired live: refused a `2026-07-22.0` baseline against `2026-08-19.0` in **0.33s** |
| Quota guard | `autoresearch/config.py` `_check_quota` | fired live on the real session-limit string; returned healthy in 5.6s against live subscription |
| Network probe | `autoresearch/config.py` `probe_network` / `network_problem` | live: `6/6 ok, median 8s, spread 1.7x` |
| OpenRouter provider pin | `autoresearch/orproxy.py` | falsification: `provider=openai` refused 404 ("No allowed providers"), `provider=anthropic` succeeded. Agentic loop through it: 2 turns, Bash executed |
| Skill-shadowing sentinel | manual, via real `runner.ask()` | `QUETZAL-7731-ARMB` reached the agent with no flags => prompt lever connects |
| Calibration, OpenRouter half | `experiments/runs/calibration-3009509/openrouter.json` | completed 5/5 in 14 min |
| Tests | `autoresearch/tests/test_scoring.py` | **84 pass** |

### Two numbers that were blocking decisions

**Measured OpenRouter cost: `$0.1942` per question** (2 repeats), `$0.9709` for 5.
The README's `$0.50`/evaluation is a subscription-era estimate; the real figure
is ~2.6x cheaper. A 60-evaluation run is ~**$11.65**, not $30. Both GEPA arms
fit inside the $82.96 ceiling with room left.

**Correctness ceiling: `0.0260`.** Headroom is 1.30 correctness points across
only 9 questions (21 of 30 already score 1.0); 1.30/30 x 0.60 = 0.0260.
Efficiency headroom is **0.200** — 7.7x larger — because `efficiency()` scores
parity at 0.5, so the top half of both terms is always available.

## 2. Done but unverified

- **The calibration per-term comparison was never run.** OpenRouter data exists;
  it was never compared against the subscription baseline. **No agreement claim
  has been made and none should be inferred.**
- **`agent_provider` records what we told it, not what OpenRouter served.** The
  pin is verified honoured; the recorded string is a claim, not a read-back.
  `/v1/messages` omits provider and the generation endpoint 404s.
- **`agent_path`/`agent_provider`/`agent_model` in `3009509.json` were
  backfilled**, not captured live — the measuring process predated the fields.
  Evidence recorded in the record's `agent_fields_backfilled` key.
  Reconstructed, not observed.
- **The preflight guards have never run inside a real `optimize` run.** Tested
  standalone and unit-tested only.
- `orproxy.py` has handled ~15 requests. Not exercised at 60-evaluation scale.
- F5/F7 assignment **not started**. Only F5's location was confirmed: the
  defect is `botmap/evals/runner.py:52` and `:76` (`--json` after the
  subcommand), which is Arm A's file. `autoresearch`'s two `--json` uses
  (`config.py`, `smoke.py`) are correctly ordered.

## 3. Open questions

1. Does the prompt lever get funded at all, given a correctness ceiling of
   0.026 and 21/30 questions already perfect?
   Options: (a) fund it and judge on efficiency, where headroom is 0.200;
   (b) defer until ground truth changes what correctness means; (c) drop it.
2. Should `WEIGHTS` change? Correctness carries 0.60 of the objective while
   offering 0.026 of achievable gain.
   Options: re-weight toward efficiency; leave it and report the ceiling as a
   finding; wait for ground truth. (Arm C's file.)
3. Is cross-path calibration still wanted?
   Options: finish the comparison from data already paid for (offline, ~$0);
   re-run both halves after the instrument fixes; abandon the OpenRouter path.
4. Does `agent_provider` need to be observed rather than asserted?
   Options: accept the pin as sufficient; build read-back capture in the proxy;
   drop provider recording.
5. Who owns `botmap/evals/runner.py` for F5? It is Arm A's exam harness but the
   fix was assigned to Arm B.

## 4. What breaks if resumed cold in a week

- **`~/.claude/skills/botmap` is moved aside** to
  `~/.claude/botmap-skill-DISABLED-BY-ARM-A`. If restored, every prompt-lever
  candidate silently becomes void — written to a file the agent never reads —
  and the run produces a **clean-looking null result**. Most dangerous item
  here. The sentinel check is manual and was never automated.
- **The map-data release will roll again.** `2026-08-19.0` is unpinned. When it
  moves, `3009509.json` is stale. The release guard now catches this, but the
  baseline must be re-measured (~2h, subscription quota).
- **`~/.cache/botmap` is user-global and shared by all arms**, and
  `cache.ensure_index` validates only `target.exists()`. A truncated 330MB
  write is accepted as valid forever. Not fixed: botmap is the tool under test.
  Proposed fix (unapplied): write to `.parquet.tmp` then `os.replace`; validate
  existing files with `pq.read_metadata`, which reads only the footer.
- **Three quarantined files must stay quarantined.** Restoring any to a
  canonical path reintroduces a silent wrong-yardstick failure:
  `experiments/baselines/3009509.INCOMPLETE-5of30.json` (5/30, quota-killed),
  `experiments/baselines/3009509.release-2026-07-22.0.STALE.json`,
  and the deferred run-2 script (renamed to `.py.txt` so it cannot be invoked).
- **`BOTMAP_REPO` must be `/Users/priyangapkini/workspace/ar-b/botmap`.**
  Pointing at the shared `~/workspace/botmap` collides on
  `botmap-oa-<sha>-0` and one run deletes another's worktree mid-flight.
- **`detected_release()` needs a `.venv` in `BOTMAP_REPO`**, or the release
  guard degrades to an "unchecked" warning — the exact case it exists to catch.
  `ar-b` is synced; other arms' clones may not be.
- **Scratchpad state will NOT survive.** These live only under
  `/private/tmp/claude-501/.../scratchpad/` and are not in git:
  `arm-b-notes.md` (4 findings, incl. the orphaned-`claude -p` quota drain and
  the cross-arm coordination failure), `measure_baseline.py`, `calibrate.py`,
  `check_baseline.py`, `RUN2-DEFERRED.md`, and all run logs.
- **`experiments/runs/` and `experiments/baselines/` are gitignored**, so the
  baseline and its 60 attempts exist only on this machine.
