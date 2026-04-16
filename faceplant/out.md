# Faceplant implementation notes

## Architecture summary

- **Executable structure:** one Zig binary with a tiny hand-rolled HTTP server, background scrape loop, and background alert loop.
- **Startup lifecycle:** open/create SQLite database, load or initialize instance secret, start scraper thread, start alert evaluator thread, then serve HTTP.
- **Storage model:** a single SQLite database at `$FACEPLANT_DATA_DIR/faceplant.sqlite` stores config, sessions, dashboards, panels, scrape targets, metric samples, logs, alert rules, alert state, and alert history.
- **Metrics ingestion path:** scrape Prometheus text endpoints over plain HTTP, parse exposition lines, normalize labels, and write samples into SQLite.
- **Logs ingestion path:** accept Loki-like JSON at `/api/logs/push`, normalize labels, and persist entries into SQLite.
- **PromQL support strategy:** support a useful subset by parsing selectors, simple aggregations, and a few range functions and evaluating them over SQLite-backed samples.
- **Loki-style query strategy:** support selector + contains/excludes filters for line queries plus `count_over_time()` and `rate()` for common metric-from-logs use cases.
- **Alert evaluation path:** periodically evaluate stored rules, compare the last computed value with the threshold, persist current state, append history.
- **HTTP route layout:** page routes for login/dashboards/logs/alerts/settings; JSON routes for metrics, logs, alerts state, manual scrape, and health.
- **Frontend structure:** plain HTML pages, reset stylesheet, tiny inline JS, Apache ECharts from CDN for time-series rendering.
- **Testing strategy:** focused unit/integration-style tests on auth, dashboard CRUD, metrics/logs ingestion, representative PromQL/LogQL behavior, alert evaluation, and route protection.

## Notes

- Secure cookies are emitted even though local browser behavior for non-HTTPS development can vary.
- Query support is intentionally common-case only and documented in `README.md`.
- Metrics scraping currently supports `http://` targets, not HTTPS.
- Data is intentionally kept in one SQLite file to satisfy the single-data-directory requirement.
- The UI is intentionally plain and only minimally styled.

## Validation run

- `nix develop -c zig build test`
- `nix build .#default`
- `nix run .#test`
