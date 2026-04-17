# Faceplant

> Note: this project and much of its current implementation/documentation were generated iteratively with AI coding assistance.

Faceplant is a single-binary, self-hosted local observability stack.

It combines a minimal subset of Prometheus, Grafana, Loki, and Alloy-style workflows into one executable with one data directory.

## What it includes

Phase 1-delivered core features:
- shared-secret login
- dashboard CRUD
- metrics scraping and storage
- PromQL-style querying for common selectors, aggregations, and range functions
- logs HTTP push ingestion
- Loki-style / LogQL-style querying for common selectors and text filters
- alerts with persisted state and history
- minimal HTML UI with Apache ECharts graphs
- SQLite-backed storage under one data directory
- Nix build and test targets

Additional maturity included beyond the MVP:
- `!=` label matching
- `min` / `max` metric aggregations
- `last_over_time()`
- `rate()` and `count_over_time()` for logs
- alert history persistence and UI visibility
- human-readable alert timestamps in the UI
- manual scrape trigger from settings
- scrape target edit/delete flow
- basic diagnostics summary in Settings
- authenticated `/status` page
- `/metrics` endpoint for internal self-observability metrics
- HTML escaping for user-provided dashboard, panel, alert, and scrape-target values in rendered pages
- internal self-observability loggers routed through the same Loki-like ingest surface
- stat panel support
- logout flow

## Build

### With Nix

```bash
nix build .#default
```

### With Zig

Use a Zig 0.16.x toolchain and SQLite development libraries.

```bash
zig build -Doptimize=ReleaseSafe
```

## Run

```bash
FACEPLANT_DATA_DIR=./data ./zig-out/bin/faceplant
```

Optional environment variables:
- `FACEPLANT_PORT` - HTTP port, default `8080`
- `FACEPLANT_DATA_DIR` - data directory, default `./data`
- `FACEPLANT_SECRET` - shared secret; if omitted, the first successful login sets the secret for the running instance and persists it in SQLite
- `FACEPLANT_DERIVED_LOGS` - enable the derived/amplifying internal logger (`1` or `true`)

## Authentication behavior

- If `FACEPLANT_SECRET` is set, that exact secret is required.
- If it is not set, the first entered secret becomes the instance secret.
- Successful login sets an HTTP-only cookie.
- The cookie is emitted with `Secure` and `SameSite=Strict`.

### Cookie / HTTPS note

For real browser use, `Secure` cookies are intended for HTTPS. On localhost during manual development, browser behavior can vary. Faceplant keeps the cookie model intentionally simple and assumes a trusted local deployment or HTTPS termination upstream.

## Data directory behavior

All persistent state lives in one SQLite database file under the chosen data directory:

- dashboards
- panels
- alert rules
- alert state and history
- sessions
- scrape target configuration
- metrics samples
- logs

Database path:

```text
$FACEPLANT_DATA_DIR/faceplant.sqlite
```

## Metrics ingestion

Metrics are scraped from Prometheus-style text endpoints.

1. Open **Settings**.
2. Add a scrape target URL such as `http://127.0.0.1:9090/metrics`.
3. Faceplant will scrape in the background.
4. You can also click **Scrape now**.

Example useful queries:

```promql
cpu_usage
cpu_usage{host="a"}
sum(cpu_usage)
max(cpu_usage)
rate(requests_total{job="demo"}[5m])
avg_over_time(cpu_usage{host="a"}[15m])
count_over_time(cpu_usage[5m])
last_over_time(cpu_usage[5m])
```

## Logs ingestion

Push logs to `/api/logs/push` using a Loki-like shape:

```json
{
  "streams": [
    {
      "labels": { "app": "demo", "level": "info" },
      "entries": [
        { "ts": 1710000000000, "line": "hello" }
      ]
    }
  ]
}
```

Example query patterns:

```logql
{app="demo"}
{app="demo"} |= "error"
{app="demo",level!="debug"} |= "timeout"
count_over_time({app="demo"}[5m])
rate({app="demo"} |= "error" [5m])
```

## Minimal route map

- `GET /login` - login page
- `POST /login` - authenticate
- `POST /logout` - clear session and return to login
- `GET /` - dashboard list
- `POST /dashboards/create` - create dashboard
- `GET /dashboard/:id` - dashboard detail
- `POST /dashboard/:id/rename` - rename dashboard
- `POST /dashboard/:id/delete` - delete dashboard
- `POST /dashboard/:id/panels/create` - create panel
- `POST /dashboard/:id/panel/:panel_id/delete` - delete panel
- `GET /logs` - logs page
- `GET /alerts` - alerts page
- `GET /settings` - settings page
- `GET /status` - authenticated status/diagnostics page
- `GET /metrics` - Prometheus-style internal metrics endpoint
- `POST /settings/scrape-targets` - add scrape target
- `POST /settings/scrape-target/:id/update` - update scrape target
- `POST /settings/scrape-target/:id/delete` - delete scrape target
- `POST /api/logs/push` - ingest logs
- `GET /api/logs/query` - execute LogQL-style query
- `GET /api/metrics/query` - execute PromQL-style query
- `GET /api/alerts/state` - current alert state as JSON
- `POST /api/admin/scrape` - trigger immediate scrape
- `GET /healthz` - basic health endpoint

## Query limitations / deviations

Faceplant intentionally supports the common path, not full upstream compatibility.

### PromQL limitations

Implemented:
- metric selectors
- exact and `!=` label matching
- range selectors like `[5m]`
- `sum`, `avg`, `count`, `min`, `max`
- `rate`, `avg_over_time`, `sum_over_time`, `count_over_time`, `last_over_time`

Not implemented:
- binary arithmetic between vectors
- joins / vector matching
- subqueries
- regex label matching
- full Prometheus staleness and extrapolation semantics
- counter reset handling parity with Prometheus

### LogQL limitations

Implemented:
- label selectors
- exact and `!=` label matching
- `|=` text filters
- `!=` text exclusion filters
- `count_over_time`
- `rate`

Not implemented:
- parser pipeline stages
- formatting stages
- regexp filters
- Loki chunk/index behavior
- full metric-from-logs aggregation parity

## Internal self-observability metrics

Faceplant also exposes internal Prometheus-style metrics at `/metrics`.

Current metrics include counters/gauges for:
- handled HTTP requests
- failed HTTP requests
- metric samples ingested
- log entries ingested
- scrape runs and scrape failures
- alert evaluations and transitions
- internal stable/derived log emissions
- dropped derived logs
- current row counts for key SQLite tables
- process uptime

`/metrics` is intentionally read-only and excluded from the generic request counter so self-scrapes do not perturb that metric.

## Internal self-observability loggers

Faceplant now has two internal logger classes that both route through the same Loki-like log-ingest surface semantics:

- **stable logger** - for lifecycle, auth, scrape, and alert transition events; intended to stay bounded by system actions
- **derived logger** - for log-driven/debug-style events that may scale with log activity; disabled by default and protected by a token bucket

Guardrails:
- stable logs are the default internal operational stream
- derived logs are labeled separately with `logger="derived"`
- derived logging is disabled unless `FACEPLANT_DERIVED_LOGS` is enabled
- derived logging is burst/sustained-rate limited and dropped events are summarized later via the stable logger
- internal self-logs are inserted through the same Loki-like ingestion payload handling, but ingesting them does not recursively generate more internal logs

Example selectors:

```logql
{app="faceplant",source="self",logger="stable"}
{app="faceplant",source="self",logger="derived"}
```

## Feature limitations

- intentionally minimal UI
- no multi-user support
- no RBAC
- no notifications
- no clustering
- no retention policies yet
- HTTP scraping currently supports plain `http://` targets only
- diagnostics are intentionally basic counts, not a full admin/status system

## Testing

Run the fast test suite with:

```bash
nix run .#test
```

Or from a shell with SQLite available:

```bash
zig build test
```

## Phase 1 vs Phase 2

### Delivered Phase 1

The MVP scope is implemented.

### Delivered Phase 2-style follow-up in this iteration

A subset of post-MVP maturity was included where it stayed small and pragmatic:
- broader common-case query support
- stat panels
- alert history persistence
- manual operational scrape control
- additional aggregations and filters

### Deferred further Phase 2 depth

The following are still intentionally deferred:
- richer dashboard layout editing
- more complete PromQL and LogQL compatibility
- notifications
- retention/compaction features
- advanced diagnostics pages
- polished dashboard UX
