# Arm C — handover

Branch `feat/agent-struggle-scorer`, worktree `/Users/priyangapkini/nilenso/ar-c-autoresearch`.
15 commits, **none merged into `feat/autoresearch`**. 145 tests pass. Tree clean —
nothing stashed, no WIP commit. No quota spent at any point.

Arm C owns: `taxonomy.py`, `score.py`, `evaluator.py`, config weights.

## 1. Done and verified

Verified = I ran it and read the output.

| commit | what | how verified |
|---|---|---|
| `ab5e899` | struggle scorer — silent/waste/path/recovery, weight 0.35; correctness 0.60→0.45 | unit tests incl. the completion-gate inversion test (giving up must not beat answering) |
| `1ee5bd2` | read-only whole-repo context injected into GEPA `background` | assembled it: 56,961 chars ≈ 14.2k tokens/proposal; `core.py` source present, `cli.py` not duplicated |
| `c0a8bcf` | baseline stamped `proxy-v1`, not the run's scorer name | test asserts the stamp names the function that produced the numbers |
| `0118512` | `network_failure` label, ahead of the traceback check | tests; `network` fired 0/58 in the real baseline |
| `f6a7bd0` `0df3068` `e039e09` | noise floor, `--within-run`, lower-bound caveat printed in the report | **ran on real data** — floor 0.117 over 28 paired questions |
| `da831d7` | quota detection in `trace.py`; run aborts instead of scoring 0 | 8 tests; result-event shape confirmed against real transcripts before they were deleted |
| `7fc43f4` | **F11 inverted gradient fixed** | **ran it**: C1 scores `+0.2463` vs baseline (0.6538 → 0.9000) |
| `b4f6bc4` `0819eac` | reconcile; refuses withdrawn/partial baselines | **ran against the real files** — refuses `3009509.INCOMPLETE-5of30.json` by name |
| `047a19c` | blocked-files caveat when repo context is on | checked `BACKGROUND` is not echoed into `run_log.txt` (0 hits) |
| `60d5de8` | the noise-floor finding, written up | `autoresearch/experiments/NOISE-FLOOR-FINDING.md` on the branch |

**Reconcile result: 30/30 agree, 0 diverge, 0 unchecked.** Checked this was not
accidental: `bus-stops-with-coffee__r2` is the only attempt carrying a near-match
hint, and it already had 4 `bad_option` errors, so that call joining `.errors`
under arm B's taxonomy changes nothing (penalty is 0.1/0.3 regardless of count).
The shared baseline is usable by this scorer as measured.

**The measurement finding.** From `3009509.json` + its 60 retained attempts:

    within-run noise floor (lower bound)   0.117
    total achievable headroom              0.039   -> floor is 3.0x the prize
    correctness ceiling on this branch     0.0195  (not 0.026 — correctness is 0.45 here)
    `silent` sub-term                      fired 0/58, headroom 0.0000

Correctness is drowned 2.3x under its own noise; wallclock sits exactly at parity.
Quarantining the 5 worst questions still leaves 1.5x. Closing a 3x gap by repeats
needs ~9x the sample (~$135/baseline). The bank needs harder questions, not more
measurement — 21 of 30 already score perfectly.

## 2. Done but unverified

- **Nothing has ever run through GEPA.** Every scorer change is exercised by unit
  tests and hand-built cases only. `optimize.py` end-to-end is unproven. The smoke
  check passes and the end-of-run summary serialises, but **no candidate has ever
  been scored by this code**.
- **Two of three quota markers are guesses.** Only `"session limit"` was seen in a
  real transcript. `"usage limit"` and `"rate limit"` are unconfirmed and the
  evidence is no longer on disk.
- **`--repo-context-chars` has never been measured**, only assembled. Whether the
  repo context helps GEPA is untested — that is the arm's whole premise.
- **`QuotaExhausted` aborting a live run is untested in a live run.** Only that the
  evaluator raises it.
- **The registered `core.py` prediction is untested**, by construction: it needs a
  real run.

## 3. Open questions

**Q1. Do these 15 commits merge into `feat/autoresearch`?** The F11/F10 check read
the shared checkout and correctly found both defects live there; the fixes are real
but unmerged. Options: (a) merge now so all arms share one scorer; (b) leave
isolated until a run happens; (c) cherry-pick only the scorer fixes.

**Q2. Should `quota_exhausted` also go in `taxonomy.py`?** `classify()` takes a
`Call`, and the quota message never appears in one — 0 occurrences across every
`commands.jsonl` when the evidence still existed. Options: (a) leave it at the
transcript layer where it fires; (b) add the taxonomy label anyway for consistency,
accepting a branch that cannot execute; (c) revisit when a quota failure recurs.

**Q3. Given floor 0.117 vs headroom 0.039, is a 60-evaluation run worth ~$30?** The
score cannot demonstrate an improvement. The registered `core.py` prediction is
unaffected by that and pays off either way. Options: (a) fund it for the prediction
alone; (b) defer until arm A's ground-truth work restores headroom; (c) cancel.

**Q4. Do the two unstable questions get quarantined?** `ev-charging-gap` swings
0.800 between identical repeats, `bus-stops-with-coffee` 0.600. Excluding the 5
worst still leaves 1.5x. Any exclusion must be decided from this null-condition
data *before* candidates are scored, or it is selection rather than calibration.
Options: (a) quarantine and record why; (b) keep all 30 and accept the floor;
(c) replace them with harder questions during arm A's ground-truth work.

**Q5. Do the weights get re-derived?** They were set before the ceiling was known
and were explicitly deferred as fix #4, pending arm A changing what "correct" means.

## 4. What breaks if resumed cold

- **`~/.claude/skills/botmap` is moved aside** to `~/.claude/botmap-skill-DISABLED-BY-ARM-A`.
  This affects normal Claude use, not just the experiment.
  Restore: `mv ~/.claude/botmap-skill-DISABLED-BY-ARM-A ~/.claude/skills/botmap`
- **The baseline is release-locked.** `experiments/baselines/3009509.json` is valid
  only for map release `2026-08-19.0`. Another rollover silently invalidates it;
  that has already destroyed two measurements. Arm B's release guard is written but
  **uncommitted in the shared checkout's working tree** — it is not on this branch
  and was never cherry-picked.
- **Worktrees live on disk**: `~/workspace/ar-{a,b,c}/botmap` plus
  `~/workspace/ar-c/botmap-oa-3009509-0`. `BOTMAP_REPO` must point at
  `~/workspace/ar-c/botmap` or concurrent runs delete each other's worktrees
  (`worktree.py` derives its path from `BOTMAP_REPO`'s parent and destroys any
  existing directory at that path).
- **Evidence cited above is gone.** The quota-failure transcripts and the original
  `baseline-noise-run1` attempts were deleted during cleanup. Commit messages record
  what they showed; the files cannot be re-examined.
- **`experiments/baselines/` and `TODO.md` are gitignored** — they do not travel with
  the branch. A fresh checkout has no baseline and will re-measure (~1h, ~$15).
- **Assumption that will not survive**: the noise floor is a *lower bound* measured
  from two repeats inside one session, sharing a cache state, network and snapshot.
  The true floor is higher by an unknown amount. A movement at or below 0.117 is
  definitively unproven; above it is *not* thereby proven.
