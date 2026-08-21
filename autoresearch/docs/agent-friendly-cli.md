# What makes a CLI agent-friendly?

This is the living deliverable for the autoresearch experiment. Each entry must
be backed by measurement. Hypotheses may be listed only when there is a BEFORE
trace; a property is not confirmed until a paired BEFORE/AFTER run shows the
agent did better under the same conditions.

## Evidence levels

- **Tier 1 — candidate:** a differential probe shows the tool had information it
  did not surface.
- **Tier 2 — confirmed/refuted:** a paired run shows whether surfacing that
  information helped the agent recover unaided.

## Entry template

```text
PROPERTY    what an agent-friendly CLI does
VIOLATION   the failure class that appears when it is missing
STATUS      hypothesis | confirmed | refuted

BEFORE      measured trace of an agent defeated by its absence
CHANGE      actual change and lever: tool | instructions
AFTER       measured trace with the change in place
VERDICT     confirmed | refuted, and the delta that supports it
```

## Current candidate properties

These are hypotheses from `docs/plan.md`. They are waiting for Phase 4 BEFORE
traces and later paired Phase 6 experiments.

1. Never return an empty result without saying why.
2. Name the fix, not just the problem.
3. Never silently discard input.
4. Never silently truncate output.
5. Make discovery a first-class operation.
6. Advertise only values that work.
7. Confirm what you resolved.
8. Emit progress on long operations.
9. Recovery advice must actually work.
10. One obvious spelling should work.
