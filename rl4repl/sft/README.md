# SFT data

Teacher trajectories for supervised fine-tuning of the REPL interaction policy.

These examples may mirror benchmark task *shapes*, but must not contain held-out benchmark tasks or verifier data. Trajectories use Harbor's ATIF format so successful model rollouts can later be filtered and added here consistently.

The added teacher examples cover clamping, adjacent deduplication, and preserving a final short chunk. They are intentionally distinct from the held-out benchmark functions.
