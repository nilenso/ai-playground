# Handover — Arm A (loop-as-a-skill)

Working repo: `/Users/priyangapkini/workspace/ar-a/botmap` — isolated clone pinned at `3009509`.
Written 2026-08-21. Arm A was paused mid-task; nothing below is in progress.

Arm A's assigned question — *does an agent instructed to apply GEPA's strategies
match GEPA's code scaffolding?* — is **UNANSWERED**. A full round ran honestly and
produced three verified mechanisms and zero measurable improvements. See §3 Q4.

---

## 1. DONE AND VERIFIED

"Verified" = I ran it and read the output.

| commit | branch | change | how verified |
|---|---|---|---|
| `99d993f` | `cand/count-zero-hint` | near-match hint on `count` when a category filter matches nothing | hint fires on `bus_stop` ranking `bus_station` first; control `coffee_shop`→1253 emits no hint; `places` still hints after the refactor |
| `6c04003` | `cand/skill-bus-station` | `bus_stop`→`bus_station` in `botmap/data/skill.md` (recipe 15, cheatsheet, anti-pattern) | `bus_stop`→0, `bus_station`→3, `coffee_shop`→58 in Williamsburg; no `bus_stop` left in the file |
| `05ef72c` | `cand/count-flag-parity` | `--category` / `--class` shortcuts on `count` | both exit 0 (414, 506); equivalence exact vs `--where` longhand; conflicting spellings error cleanly; confirmed base was exit 2 |
| `044f260` | `arm-a-base` | `notes/sync-candidates.sh` guard + verify-skill rewrite | ran the guard; watched it catch a 116-line skill-file revert injected into all three candidate diffs |

**Divisions index rebuilt** (unblocked all three arms):
`~/.cache/botmap/divisions-index-2026-08-19.0.parquet`, 4,658,700 rows, 332.8 MB.
Parquet metadata read before install; installed with atomic `os.replace` from a
staging dir on the same filesystem.

**Two clean baselines**, botmap's own 10-question suite, 2 repeats:
- `evals/runs/baseline` — 18/20 completed (global skill active)
- `evals/runs/baseline-projectskill` — 17/20 completed (project skill active)
- both: 0 quota deaths, 0 `curlCode 28`

**Round 1 screening**: `evals/runs/r1-{count-zero-hint,skill-bus-station,count-flag-parity}`
15/15 runs, 0 quota deaths, 0 `curlCode 28`, 5/5 project skill each.
**Result: no candidate dominates.**
- C1 — mechanism-verified; adversarial review verdict GENUINE; hint fired, was ignored once, acted on late; avoided the download fallback; final answer still factually wrong.
- C2 — no effect. Agent ignored the fix, used 21 commands (vs 7), fell back to `download -t infrastructure` (`unnecessary_download=1`), the anti-pattern its own skill file warns against.
- C3 — no effect. The new flags were used **zero times across all five runs**.

**F7 verified empirically**: with `~/.claude/skills/botmap` present, 20/20 runs loaded
the global copy; with it moved aside, 20/20 loaded the project copy.

**15 findings** in `/Users/priyangapkini/workspace/ar-a/botmap/notes/findings.md`.
F4, F5, F11 are real botmap bugs independent of this experiment. F9/F9b, F11 and
F13 are the substantive results — see §4 for why that file is at risk.

---

## 2. DONE BUT UNVERIFIED

- **`9a2496d`** is the head of `cand/count-zero-hint` — a post-review fix for a
  dead-end I introduced (interpolating `{type_}` into a recovery command that
  only supports `place`). It parses and the tool starts. **I never re-ran the
  mechanism check on it and it was never measured.** Round 1 measured `99d993f`.
  Anyone diffing the branch head is looking at something other than what was measured.
- **Reviewer defects (a) and (b) are NOT fixed.** (a) `_suggest_categories` streams
  every column with no projection, so a typo'd category on `count` — the verb
  advertised as the cheap pre-flight — pulls a large fraction of the partition.
  (b) A bbox with no data at all is reported as "category not present in this bbox",
  sending the agent to chase spellings instead of widening the box. Only (c) was fixed.
- **The verify-skill rewrite** (`.claude/skills/autoresearch-verify/SKILL.md`) —
  presence confirmed by grep only. Never exercised end-to-end on a fresh candidate.
- **The claim that `autoresearch/runner.py` shares the F7 skill-shadowing exposure
  is INFERRED FROM READING CODE, NOT TESTED.** I never ran autoresearch's runner.
  Test before acting on it.
- **`notes/cross-score-plan.md`** — never executed. There were no winners to score.
- **Ground-truth design (the paused task)** — nothing written. `experiments/` was
  read only; no file in that directory was modified by Arm A.

---

## 3. OPEN QUESTIONS

**Q1. Is `bus-stops-cambridge` a valid acceptance test for ground truth?**
Its agent refused with sound reasoning: Overture Places is sourced from business
listings, and roadside bus stops are not businesses. It found `bus_station`=12,
cross-checked against Boston, and declined to call 12 the bus-stop count.
Options: (a) keep it, treating the refusal as failure; (b) swap to
`beach-accessibility-malta`, where the agent answered about Malta **Montana**
(pop. 2) instead of Malta the country — unambiguously wrong; (c) keep it but mark
it unanswerable, making a justified refusal the correct answer.

**Q2. Does "ground truth" mean richer marking, or different questions?**
Annotating forces someone to decide the true answer, and for at least two of the
eight assigned that answer is contestable.
Options: annotate all 30; annotate only questions with an uncontested answer;
replace the contested ones.

**Q3. Should a justified refusal pass or fail?**
Today every non-answer passes (`trace.py:126`). Failing all of them teaches the
tool to fabricate. I see no way to separate "I can't, and here is why" from
"I'll report back later" without a per-question answerability judgement.
Options: fail all non-answers; add an `answerable` field per question; grade
refusals by a separate axis.

**Q4. What happens to C1, C2, C3?**
C1 is mechanism-verified and review-cleared but has **no measured evidence of
benefit**, and F9b says this suite structurally cannot produce that evidence
(maximum possible gain equals observed churn).
Options: merge C1 after fixing (a) and (b); merge C1 as-is; discard all three as
unproven; re-measure on a suite that can resolve the difference.

**Q5. When is Priyanga's global botmap skill restored?** It is still disabled — see §4.

**Q6. Does the F9b saturation result generalise to the 30-question bank?**
Measured for botmap's 10-question suite only: every question with headroom is
also unstable, and no question is both improvable and stable. The 30-question
bank has 21 of 30 already perfect and a maximum correctness gain of 0.026.
Whether it has the same defect is OPEN and needs Arm C's within-run floor.
The wider claim must not travel until it does.

---

## 4. WHAT WOULD BREAK ON A COLD RESUME

1. **Priyanga's global botmap skill is still disabled.** Moved to
   `~/.claude/botmap-skill-DISABLED-BY-ARM-A` (breadcrumb `WHY-MOVED.txt` inside).
   Their normal Claude sessions have no botmap skill until:
   `mv ~/.claude/botmap-skill-DISABLED-BY-ARM-A ~/.claude/skills/botmap`

2. **All 15 findings exist only in one untracked file in one working tree.**
   `/Users/priyangapkini/workspace/ar-a/botmap/notes/` is listed in
   `.git/info/exclude` — not committed, not pushed, absent from a fresh clone.
   Deleting that clone loses every finding. `/tmp/ar-a/` holds copies that will
   not survive a reboot. **This is the most fragile thing in the handover.**

3. **`arm-a-base` moved twice after the candidates branched.** Anyone who commits
   to base must run `./notes/sync-candidates.sh`, or every candidate diff silently
   contains a revert of the base's newer commits — which an adversarial reviewer
   will correctly read as the candidate tampering with its own verifier.

4. **The index cache goes stale at the next Overture release** (roughly monthly).
   The rebuild then fails on a degraded link because `botmap/cache.py:91` passes no
   S3 timeouts (F4). The workaround is `/tmp/ar-a/build_index.py`, which will not
   survive a reboot. The only commands that can set S3 timeouts are `download`'s
   `--connect_timeout`/`--request_timeout`; no convenience verb can.

5. **Both baselines were measured on the subscription path.** Under the
   shared-path rule, candidates measured via OpenRouter are not comparable to them.
   A matched re-baseline is ~10 evaluations (~$5).

6. **The link was timing out at 25s when Arm A stopped.** Anything measured without
   first checking the link is suspect: at that latency ~50% of `botmap` calls fail
   with `curlCode 28`, and the taxonomy records those as `traceback` — indistinguishable
   from a real botmap bug (F6).

7. **Tooling that lives only in `/tmp/ar-a/`** and will not survive a reboot:
   `run_evals.py` (the eval driver that skips the broken `ensure_cache`, F5),
   `agg.py`, `build_index.py`, `minibatch.yaml`. Copies of the notes are in
   `notes/` in the working tree; the scripts are not.
