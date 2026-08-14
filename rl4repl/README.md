# rl4repl

Experiments in training and evaluating small models that repair Clojure code using REPL feedback.

## Layout

- `sft/` — teacher trajectories used for supervised fine-tuning
- `bench/` — held-out Harbor tasks, verifiers, rewards, and evaluation configuration

SFT examples teach the desired interaction policy. Benchmark tasks measure whether the resulting model generalizes; benchmark tasks and hidden verifier data must not be included in SFT training data.

## Target model

The initial small-model baseline is the instruction-tuned
[`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it) checkpoint.
Record the exact runtime, quantization, prompt/tool protocol, decoding settings, and
number of attempts with every result. A failure from a quantized checkpoint must
not be presented as a full-precision model result.

## Commands

```sh
nix develop
just check
just verify-oracle
just bench <agent> <model>
```
