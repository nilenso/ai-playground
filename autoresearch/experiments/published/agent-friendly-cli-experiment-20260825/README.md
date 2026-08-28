# Agent-friendly CLI experiment — published trail

This directory preserves the documented steps and artifacts from the autoresearch/botmap experiment whose research question was:

> What makes a CLI agent-friendly?

It is an index over the work done by the orchestrator and Arms A–D. The raw run directories remain under `experiments/runs/` and may be gitignored/large; this directory keeps compact summaries, worktree metadata, and pointers to the evidence.

## Core evidence

- Plan: `../../docs/plan.md`
- Living synthesis: `../../docs/agent-friendly-cli.md`
- Orchestrator handover: `../orchestrator/HANDOVER.md`
- Stop marker: `../orchestrator/ARMS_STOPPED.txt`
- Relaunch snapshot: `../orchestrator/subagent-relaunch-20260824T055038Z/SNAPSHOT.md`

## Baseline measurement

Source run:

```text
experiments/runs/agenteval-measurement-3009509/
experiments/runs/agenteval-measurement-3009509-retry-incomplete/
```

Compact snapshots:

- `run-summaries/agenteval-measurement-3009509.json`
- `run-summaries/agenteval-measurement-3009509-retry-incomplete.json`

Corrected combined histogram after repairing MA/MT state-code ambiguity:

```json
{
  "records": 60,
  "attempts_with_failures": 34,
  "class_counts": {"clean": 389, "C": 55, "B": 15, "A": 38, "D": 3},
  "subtype_counts": {"c-truncated": 25, "c-unknown": 25, "c-wrong-type": 3, "c-wrong-column": 2}
}
```

## Confirmed paired experiments

### Categories truncation hint

- Result: `../paired/categories-truncation-hint/result.md`
- Change patch: `../paired/categories-truncation-hint/change.patch`
- Snapshot: `run-summaries/after-categories-truncation-hint-00bff1a.json`
- Candidate: `00bff1a Warn when categories output is truncated`
- Target: `c-truncated`
- Result: `13 → 5` on matched subset
- Principle: never silently truncate output.

### Count wrong-column hint

- Result: `../paired/count-wrong-column-hint/result.md`
- Change patch: `../paired/count-wrong-column-hint/change.patch`
- Snapshot: `run-summaries/after-count-wrong-column-hint-7c794ff.json`
- Candidate: `7c794ff Hint when count filter uses class and subtype wrong`
- Target: `c-wrong-column`
- Result: `2 → 0` on matched subset
- Principle: if a value exists elsewhere, say where.

### Wrong-type hint

- Arm: D
- Plan: `../arm-d/PLAN.md`
- Insights: `../arm-d/INSIGHTS.md`
- Snapshot: `run-summaries/after-wrong-type-hint-tool-9ba1187.json`
- Candidate: `9ba1187 Hint when zero count matches another type`
- Target: `c-wrong-type`
- Result: `3 → 0` on matched subset, but only `2/4` attempts completed
- Principle: if the same filter works under another type, name the type.
- Status: narrow/provisional.

## Arm reports

Each arm was stopped on 2026-08-25 and asked to summarize insights. Their reports are the main human-readable record of what each arm did and learned.

| Arm/session | Role | Reports |
|---|---|---|
| Arm A | loop-as-a-skill / existing candidate screening | `../arm-a/INSIGHTS.md`, `../arm-a/GENERAL-PRINCIPLES.md`, `../arm-a/HANDOVER.md` |
| Arm B | prompt-lever GEPA | `../arm-b/INSIGHTS.md`, `../arm-b/GENERAL-PRINCIPLES.md`, `../arm-b/HANDOVER.md` |
| Arm C | full-repo context/edit optimizer, evaluator excluded | `../arm-c/INSIGHTS.md`, `../arm-c/GENERAL-PRINCIPLES.md`, `../arm-c/HANDOVER.md` |
| Arm D | next-experiment planning + wrong-type hint paired test | `../arm-d/PLAN.md`, `../arm-d/INSIGHTS.md`, `../arm-d/GENERAL-PRINCIPLES.md` |
| Derivation | principle derivation | `../derivation/GENERAL-PRINCIPLES.md` |
| Blog ideation | narrative synthesis | `../blog-ideation/GENERAL-PRINCIPLES.md` |

## Arm run snapshots

Compact JSON snapshots copied from ignored run directories:

- `run-summaries/arm-a-new-evaluator-count-zero-hint-9a2496d.json`
- `run-summaries/arm-a-new-evaluator-skill-bus-station-6c04003.json`
- `run-summaries/arm-a-new-evaluator-count-flag-parity-05ef72c.json`
- `run-summaries/prompt-3009509-1787544952.json`
- `run-summaries/tool-3009509-1787550419.json`

Key arm outcomes at halt:

- Arm A completed two full 60-attempt candidate screenings and was stopped during the third.
- Arm B prompt GEPA finished; summary recorded `evaluations_run: 63`, `candidates_tried: 5`, and no changed best file.
- Arm C corrected full-repo GEPA finished; evaluator files were excluded, but the best patch was not a useful product change and mostly changed `.gitignore`/notes.
- Arm D completed the wrong-type hint paired experiment and wrote the next-experiment plan.

## Worktree snapshots

See `worktrees/` for each botmap clone’s state:

- `worktrees/arm-a.md`
- `worktrees/arm-a.commits-since-3009509.patch`
- `worktrees/arm-a.uncommitted.patch`
- `worktrees/arm-b-candidates.md`
- `worktrees/arm-b-candidates.commits-since-3009509.patch`
- `worktrees/arm-b-candidates.uncommitted.patch`
- `worktrees/arm-b-clean.md`
- `worktrees/arm-c-clean.md`
- `worktrees/arm-c-original.md`

These preserve the branch/commit trail and candidate patches from external botmap checkouts used by the arms.

## General principles currently supported

Strongest evidence-backed principles:

1. **Never silently truncate output.** Agents treat capped lists as complete unless told otherwise.
2. **If a value exists elsewhere, say where.** Schema-aware zero-result diagnostics prevent confident false absence.
3. **Preserve machine-readable stdout; put recovery guidance on stderr or structured metadata.** Both confirmed tool hints used this pattern.
4. **Agent-friendly CLIs teach recovery, not just syntax.** The next action matters more than a usage dump.
5. **Treat silent wrong answers as first-class failures.** Successful exit status can be more dangerous than a crash.

Promising but less-confirmed principles:

- Never return ambiguous zero without diagnostics.
- If data lives under another type/verb, name that route.
- Convert common raw usage errors from class A to guided class B.
- Make discovery commands first-class, targeted, cheap, and searchable.
- Echo resolved entities/scopes/defaults.
- Emit progress/estimates for expensive operations.

## Instrumentation lessons

- Build the evaluator before optimizing. The old scorer could not see the most important failure: silent wrongness.
- Keep the evaluator/readout read-only. Arm C’s first full-repo mode accidentally allowed `evals/*`; those runs were invalidated.
- Separate tool, environment, and agent-side blame. Quota/network failures and ignored hints need different treatment.
- Probe bugs can manufacture product insights. The MA/MT state-code repair changed the failure distribution.

## Source file manifest

`source-files.txt` lists the report/plan/source files that existed when this publication directory was generated.
