# rl4repl

Experiments in training and evaluating small models that repair Clojure code using REPL feedback.

## Layout

- `sft/` — teacher trajectories used for supervised fine-tuning
- `bench/` — held-out Harbor tasks, verifiers, rewards, and evaluation configuration

SFT examples teach the desired interaction policy. Benchmark tasks measure whether the resulting model generalizes; benchmark tasks and hidden verifier data must not be included in SFT training data.

## Commands

```sh
nix develop
just check
just verify-oracle
just bench <agent> <model>
```
