# Gemma 4 E2B local baseline — 2026-08-14

## Scope

This is a local, resource-constrained screening run for benchmark candidates
`0003`–`0005`. It is evidence about the stated quantized checkpoint and protocol,
not about the full-precision checkpoint.

## Model and runtime

- Checkpoint family: `google/gemma-4-E2B-it`
- GGUF: `unsloth/gemma-4-E2B-it-GGUF`, `UD-Q2_K_XL`
- GGUF SHA-256: `2bfeb49803da8db274b3fbac3c1d471903be64d382c237c6f509ccaa9cc141a2`
- GGUF size: 2,403,614,816 bytes
- Runtime: `llama-server` bundled with Ollama 0.32.9
- Backend: CPU, memory-mapped weights, repacking disabled
- Context: 2,048 tokens
- Generation: temperature 0, at most 512 output tokens, reasoning disabled
- Attempts: one per task per protocol

The standard Ollama `gemma4:e2b` Q4 image could not load under the process's
4 GiB cgroup limit: it reported approximately 5.47 GiB required and was killed.
The smaller Q2 checkpoint was therefore used. This limitation matters: these
results must not be generalized to Q4 or full precision.

## Agentic repair protocol

The model received each task's public instruction and could call four tools:

1. `read_source`
2. `repl_eval`
3. `replace`
4. `write_source`

Verifier tests remained hidden and ran only after the agent stopped. All three
attempts reached verification without an infrastructure error.

| Task | Result | Observed behavior | Hidden verifier |
| --- | --- | --- | --- |
| `0003-rotate-left` | Fail | Did not inspect or edit the source; generated a long incorrect explanation | 2 failures / 7 assertions |
| `0004-token-frequencies` | Fail | Read the source but did not edit it; incorrectly treated `(update counts token inc)` as a complete counter | Errors on missing map entries |
| `0005-prefix-sums` | Fail | Read the source but did not edit it; incorrectly claimed seeded `0` was not included | 5 failures / 5 assertions |

Raw trajectories are in the ignored directory `jobs/gemma4-e2b-local-q2/`.

## Easier one-shot control

As a control for tool-protocol failure, the model received the same public
instruction plus the complete source and was asked to return only a complete
repaired file. All three outputs were non-empty, parsed, and passed to the same
hidden verifiers; all failed:

| Task | Result | Output defect |
| --- | --- | --- |
| `0003-rotate-left` | Fail | Invented non-Clojure `size` and `slice` symbols |
| `0004-token-frequencies` | Fail | Produced an unmatched delimiter and invalid logic |
| `0005-prefix-sums` | Fail | Invented `apply-axes` and produced an unmatched delimiter |

Raw control outputs are in the ignored directory
`jobs/gemma4-e2b-local-q2-one-shot/`.

## Interpretation

The three candidates are empirically unsolved in this **single-attempt,
UD-Q2_K_XL local baseline**. This does not establish that they are unsolved by
Gemma 4 E2B at Q4, full precision, or under repeated sampling. Use stronger
precision and multiple attempts before making a model-family-wide claim.
