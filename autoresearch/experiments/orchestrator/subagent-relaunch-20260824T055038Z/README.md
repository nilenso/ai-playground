# Subagent relaunch handoff

Snapshot: experiments/orchestrator/subagent-relaunch-20260824T055038Z/SNAPSHOT.md

Use this directory as the durable state handoff for replacing Herdr arm panes
with Pi subagents. Existing background processes must not be duplicated.

Current intended ownership:
- Arm A subagent: monitor/continue /tmp/arm_a_full_agenteval.py and arm-a-new-evaluator-* run dirs.
- Arm B subagent: monitor prompt optimizer run experiments/runs/prompt-3009509-1787544952.
- Arm C subagent: monitor valid no-evaluator optimizer run launched from experiments/runs/arm-c-full-repo-no-evaluator-launch-20260824-111659.log.

Invalid Arm C runs:
- experiments/runs/tool-3009509-1787544884 and immediately following stopped no-evaluator run are invalid/stopped because edit surface allowed evaluator or evaluator-adjacent files.

Do not relaunch unless the process is gone and the run is incomplete.
