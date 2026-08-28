# Arm A insights — loop-as-a-skill under the new evaluator

Written after user halt on 2026-08-25. Active experiment processes were terminated by the orchestrator at 2026-08-25T16:42:21Z to stop spend. Incomplete runs below are intentionally stopped, not candidate failures.

## 1. What Arm A was testing

Arm A tested the thesis that an agent can run the research loop itself, using explicit skills and trace evidence, rather than GEPA's optimizer loop. In the first phase this meant proposing and verifying botmap usability candidates manually. After the evaluator-first reset, Arm A's role shifted to measuring those existing candidates with the shared `record-v2` / `autoresearch.agenteval` evaluator instead of botmap's old eval scorer.

The relevant question was not "does a botmap patch improve the old score?" but:

> Does the candidate reduce recorded agent-facing failure classes, improve recovery, or generate evidence for `docs/agent-friendly-cli.md`?

Arm A's three existing candidates were:

| Candidate | Commit measured here | Lever | Intended property |
|---|---:|---|---|
| `cand/count-zero-hint` | `9a2496d` | tool | Name the fix / turn silent zero into guided recovery |
| `cand/skill-bus-station` | `6c04003` | instructions | Tell the agent that `bus_station` is the working value, not `bus_stop` |
| `cand/count-flag-parity` | `05ef72c` | tool | Accept the flags agents naturally try on `count` |

Important caveat: old Arm A originally measured `count-zero-hint` at `99d993f`; this full new-evaluator run measured the branch head `9a2496d`, because the user explicitly asked to measure existing Arm A candidates. Treat comparisons to old Arm A Round 1 as non-identical.

## 2. What ran / did not run

### Shared evaluator preparation

Before the full run, Arm A updated its old local skills to use the new evaluator concepts: `record-v2`, sabotage gate, `agenteval.enrich/analyze/explain`, class histograms, and `docs/agent-friendly-cli.md` entries. Those skill edits were stashed before candidate screening so the botmap workspace could switch branches cleanly.

Evaluator gate before screening:

```text
uv run pytest tests/test_sabotage.py tests/test_agenteval_taxonomy.py tests/test_probe.py tests/test_analyze_records.py
26 passed
```

Global botmap skill check:

```text
~/.claude/skills/botmap not present
```

Network preflight:

```text
experiments/runs/arm-a-new-evaluator-preflight-20260824T041555Z/
2/2 botmap count probes succeeded, 19.47s and 12.74s
```

### Candidate run directories

All runs used the full 30-question autoresearch bank with repeats 1 and 2 planned, via the shared autoresearch runner path:

```text
autoresearch.runner -> attempts/*/{commands.jsonl,transcript.jsonl,record-v2.json}
```

Run directories:

```text
experiments/runs/arm-a-new-evaluator-count-zero-hint-9a2496d/
experiments/runs/arm-a-new-evaluator-skill-bus-station-6c04003/
experiments/runs/arm-a-new-evaluator-count-flag-parity-05ef72c/
```

The first two completed all 60 planned attempts but post-run enrichment timed out. The third was stopped by the user halt after 37/60 attempts and was not enriched.

No GEPA ran. No `botmap/evals` runner or scorer was used.

## 3. Key quantitative results so far

### Run completion / cost

| Candidate | Attempts done / planned | Completed/OK | Botmap calls | Cost USD | Duration | Enrichment |
|---|---:|---:|---:|---:|---:|---|
| `count-zero-hint @ 9a2496d` | 60 / 60 | 45 / 45 | 288 | 8.3376 | 446.8 min | failed: probe timeout |
| `skill-bus-station @ 6c04003` | 60 / 60 | 33 / 33 | 188 | 6.3566 | 1522.0 min | failed: probe timeout |
| `count-flag-parity @ 05ef72c` | 37 / 60 | 33 / 33 | 177 | 6.0575 | 203.6 min at halt | not run; halted |

Total recorded spend before halt: about **$20.75**. This excludes any negligible preflight overhead.

### Raw record-v2 class counts currently present

These are from the `record-v2.json` files already written during the runs. They are **not equivalent to the enriched Phase 4 baseline summary**, because enrichment failed or did not run for these candidates. In particular, class-C subtypes are mostly still `c-unknown` rather than differential-probe explanations.

| Candidate | Records | Attempts with failures | Class counts | Subtype counts | Agent-side |
|---|---:|---:|---|---|---|
| `count-zero-hint @ 9a2496d` | 60 | 31 | `clean`: 233, `E`: 9, `A`: 25, `C`: 4, `B`: 17 | `c-unknown`: 4 | `ignored_hint`: 1 |
| `skill-bus-station @ 6c04003` | 60 | 18 | `clean`: 147, `C`: 8, `B`: 3, `E`: 14, `A`: 16 | `c-unknown`: 8 | none |
| `count-flag-parity @ 05ef72c` | 37 | 15 | `clean`: 150, `B`: 4, `A`: 11, `D`: 1, `C`: 11 | `c-unknown`: 11 | none |

Baseline for comparison, from the completed Phase 4 measurement summary with retries:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2},
  "agent_side_counts": {}
}
```

Because candidate enrichment failed, any comparison against this baseline is only directional and unsafe. The biggest visible direction is that `count-zero-hint` produced more guided `B` calls and one `ignored_hint`, which is exactly the failure path the new taxonomy was designed to expose: the tool can give a useful hint, and the agent may still fail to use it.

## 4. Qualitative insights about agent-friendly CLI design

### A helpful hint is necessary but not sufficient

The `count-zero-hint` run produced 17 Class B guided calls and one agent-side `ignored_hint`. This supports the evaluator design choice: guidance should not be flattened into a tool failure. A CLI can do the right thing by naming a recovery path; the next question is whether the agent uses it.

This matters for the blog/derivation: agent-friendly design is not only about avoiding errors. It is about creating recovery affordances that are obvious enough to survive the agent's next step.

### Instruction-only fixes may be weak when the failure is in live output

`skill-bus-station` completed far fewer attempts than `count-zero-hint` and produced fewer guided signals in the raw records. This is not a clean refutation, because enrichment failed and run conditions were long/noisy. But it is consistent with old Arm A's qualitative finding: the agent often ignores or fails to apply a static skill correction, especially once live CLI output suggests another path.

The broader design lesson is tentative: if the CLI can detect the problem at the point of failure, output-local guidance may be stronger than prompt-local guidance.

### New affordances must be reached to matter

Old Arm A already saw `count-flag-parity` used zero times in a five-run screening. The new full run was halted before completion and not enriched, so it cannot overturn that. The risk remains: adding a reasonable flag is only useful if the agent naturally reaches for that command shape in the target failures.

Agent-friendly CLIs need both capability and discoverability. Support for an obvious spelling is good, but if the agent's path never hits that spelling, the measurable effect can be nil.

### Probe cost and robustness are part of the evaluator design

Both completed candidate runs failed during post-agent enrichment because `categories --top 2000/5000` probes timed out at 120s. This is a measurement-system insight, not a botmap candidate result. Differential probes are supposed to be cheap and offline; when a probe itself can hang, the evaluator inherits the same "silent long operation" problem it is meant to classify.

A robust evaluator should record probe timeout as inconclusive evidence and continue writing the summary, rather than aborting the entire enrichment pass.

## 5. Supported vs tentative claims

### Supported

- Arm A can run the old loop-as-a-skill candidates through the new `record-v2` runner path without using GEPA or botmap's old eval scorer.
- `count-zero-hint @ 9a2496d`, `skill-bus-station @ 6c04003`, and `count-flag-parity @ 05ef72c` all passed candidate preflight: branch checkout, compile where applicable, and `botmap --help` startup.
- The new evaluator captures a distinction the old scorer blurred: guided Class B output and agent-side ignored-hint detail can coexist.
- The current enrichment implementation is fragile under slow botmap taxonomy probes; this affected two completed candidate runs.

### Tentative / not supported yet

- No Arm A candidate can yet be claimed to improve over baseline under the new evaluator. The candidate summaries are un-enriched or incomplete.
- `count-zero-hint` looks directionally promising for converting silent failures into guided recovery, but the measured run also shows at least one ignored hint. Whether it improves final task success needs enriched matched analysis.
- `skill-bus-station` cannot be refuted from this run alone. Its completion rate was low, but many failures may be environmental or unrelated.
- `count-flag-parity` cannot be judged because the run was intentionally stopped at 37/60 attempts.

## 6. Failure modes / confounders / invalid runs

- **User halt:** `count-flag-parity` was intentionally stopped after 37/60 attempts. Treat it as incomplete, not failed.
- **Enrichment timeout:** both full completed candidate runs failed during `agenteval.enrich`, on `categories --top 2000/5000` probes against Cambridge. Therefore no `agenteval-summary.json` exists for those runs.
- **Unenriched class-C subtypes:** raw records show `c-unknown` where the Phase 4 baseline has richer subtypes like `c-truncated`. This makes direct histogram comparison misleading.
- **Different `count-zero-hint` identity:** this run measured `9a2496d`, while old Arm A Round 1 measured `99d993f`.
- **Long wall-clock / possible environment noise:** `skill-bus-station` took about 25 hours wall-clock for 60 attempts, with many zero-cost incomplete attempts near the end. This suggests environmental/runtime instability may contaminate completion counts.
- **No retry pass:** incomplete attempts were not retried before halt.
- **No final score calculation:** `agenteval.score` was not applied to candidate summaries, because enrichment did not complete and the run was halted.

## 7. Recommendation for next experiments

1. **Fix enrichment robustness before more paid runs.** Probe timeouts should become inconclusive `Probe` records, not abort the candidate summary. This is likely a small evaluator change and saves already-paid artifacts.
2. **Re-enrich existing Arm A run artifacts offline after that fix.** This should cost no model tokens, only CLI probe time, and may recover useful summaries from the two full candidate runs.
3. **Compare candidates on matched attempts only.** Use the full 60-attempt baseline only after candidate records are enriched. For `count-flag-parity`, either complete the remaining 23 attempts later or compare only the overlapping prefix with clear caveats.
4. **For `count-zero-hint`, inspect the ignored-hint trace first.** The most valuable result may be a refutation/nuance: naming the fix helps only if the guidance is formatted and placed so the agent acts on the next turn.
5. **Prefer smaller paired experiments for design claims.** The already confirmed paired experiments produced clearer evidence at 4-6 attempts than this 180-attempt screening did. Full screening is useful for broad signals, but paired subsets are better for `docs/agent-friendly-cli.md` claims.

## 8. Anything the blog / derivation sessions should know

- The most interesting Arm A result is methodological: the old score would have mishandled hints, while the new evaluator can represent "the tool guided correctly, then the agent ignored it." That is central to an agent-friendly CLI taxonomy.
- Full autonomous loops are expensive and confounded. The clearest evidence so far comes from targeted paired experiments, not broad optimizer-like sweeps.
- Static instructions are not obviously equivalent to live CLI feedback. Agents appear more likely to need context-local recovery advice at the moment of failure.
- The evaluator itself must obey the same CLI-design principles it measures: bounded operations, progress/timeout handling, and explicit inconclusive outcomes.
- Do not claim an Arm A winner yet. The run generated useful artifacts and confounders, but not a completed enriched comparison.
