# Leave data model

Jadoo models leave in `leave_records` with these leave types:

- `full` — full-day leave
- `half_am` — first half of the day
- `half_pm` — second half of the day
- `specific` — a time-specific leave interval with `start_time` and `end_time`

Additional fields:

- `date` — leave date in `YYYY-MM-DD`
- `start_time` / `end_time` — optional `HH:MM` fields used for `specific` leave
- `leave_category` — currently `vacation` or `sick`

## Migration note

Do **not** edit previously applied migration files just to update comments or documentation.

`litem8` hashes migration files, so changing even a comment in an already-run migration can break production startup with a hash mismatch.

Instead:

- add a new migration for schema changes
- document the updated data model here or in `README.md`
