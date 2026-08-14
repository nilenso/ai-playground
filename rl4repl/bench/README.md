# replbench

A Harbor benchmark for evaluating models that repair Clojure code using REPL feedback.

## Layout

- `dataset.toml` — content-pinned Harbor dataset manifest
- `tasks/` — executable benchmark tasks
  - `0001-sum-even-squares/` — simple predicate repair
  - `0002-merge-intervals/` — closed-interval boundary repair
  - `0003-rotate-left/` — negative modular rotation repair
  - `0004-token-frequencies/` — missing-map-entry update repair
  - `0005-prefix-sums/` — seeded-prefix removal repair
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

## Baseline model

Use [`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it)
as the initial small-model baseline. Do not shorten this to “Gemma 4B”: E2B is
the model's effective-parameter class, not a four-billion-parameter label or the
E2B sandbox service.

A reproducible result must name the checkpoint, precision or quantization,
runtime, decoding configuration, agent and tool protocol, attempt count, and
verifier outcome. Keep raw trajectories under `jobs/`; commit concise reports
under `results/` when a result informs benchmark-task selection.

## Dataset rules

- Keep target programs pure and deterministic.
- Split source programs before generating mutations.
- Do not expose verifier files during the agent phase.
- Never include held-out benchmark tasks or verifier data in SFT.
- Treat correctness as the primary reward.
- Derive REPL-call and edit efficiency from trajectories.
- Validate each generated task with its oracle.
