# Faceplant local notes

- Internal self-observability uses two logger classes:
  - `stable`: safe default for lifecycle/auth/scrape/alert events.
  - `derived`: potentially amplifying/log-driven diagnostics. Keep this rare.
- Both internal logger classes route through the same Loki-like ingest payload handling used by `/api/logs/push`.
- Do not add new internal logs on a per-log-entry or per-query-result basis unless they clearly belong in the derived logger.
- Prefer `stable` internal logs for bounded operational events.
- Keep derived logging guarded. It is intentionally token-bucket limited and may drop aggressively.
- Never make internal logging recursively log failures of the internal logging path itself.
- If you add more self-observability, preserve the invariant that Faceplant cannot overwhelm itself through recursive logging.
