# replbench

A Harbor benchmark for evaluating models that repair Clojure code using REPL feedback.

## Layout

- `dataset.toml` — content-pinned Harbor dataset manifest
- `tasks/` — executable benchmark tasks
  - `0001-sum-even-squares/` — simple predicate repair
  - `0002-merge-intervals/` — closed-interval boundary repair
  - each task contains the instruction, Clojure environment, hidden verifier, oracle repair, and Harbor configuration

SFT trajectories are kept separately under `../sft/`.

## Requirements

- Nix
- Docker, Harbor's supported default local environment backend

## Commands

From the repository root:

```sh
nix develop
just check
just verify-oracle
just bench claude-code anthropic/claude-sonnet-4-5
```

Harbor writes run results under `jobs/`, which is ignored by Git.

## Dataset rules

- Keep target programs pure and deterministic.
- Split source programs before generating mutations.
- Do not expose verifier files during the agent phase.
- Never include held-out benchmark tasks or verifier data in SFT.
- Treat correctness as the primary reward.
- Derive REPL-call and edit efficiency from trajectories.
- Validate each generated task with its oracle.
