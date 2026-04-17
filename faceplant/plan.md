# Faceplant

## Execution Status

### Architecture summary
- **Executable structure:** one Zig executable with an embedded HTTP server, a scrape loop, and an alert evaluation loop.
- **Startup lifecycle:** initialize SQLite in one data directory, resolve instance secret, start background workers, then serve UI/API routes.
- **Storage model:** one SQLite database file stores dashboards, panels, sessions, scrape targets, metrics, logs, alert rules, and alert history/state.
- **Metrics ingestion:** scrape Prometheus text endpoints and persist normalized samples.
- **Logs ingestion:** accept Loki-like JSON pushes and persist normalized entries.
- **PromQL strategy:** support common selectors, range functions, and core aggregations with a pragmatic custom evaluator.
- **LogQL strategy:** support common label selectors, contains/excludes filters, and basic metric-from-logs queries.
- **Alert path:** scheduled threshold evaluation over metric/log queries with persisted current state and history.
- **HTTP layout:** login, dashboards, logs, alerts, settings, health, and JSON query/ingest routes.
- **Frontend:** plain HTML, reset stylesheet, tiny inline JS, Apache ECharts for time series.
- **Testing:** fast Zig tests covering auth, dashboard CRUD, ingestion, representative query behavior, alerts, and route protection.

### Phase 1 status: complete
- [x] single executable `faceplant`
- [x] Nix build and test target
- [x] one data directory / one SQLite database file
- [x] shared-secret login and cookie session
- [x] minimal protected web UI
- [x] dashboard CRUD
- [x] metrics graph panel with Apache ECharts
- [x] logs panel
- [x] stat panel
- [x] metrics scraping and PromQL-style common-case querying
- [x] logs HTTP push and LogQL-style common-case querying
- [x] alert rule creation and alert state view
- [x] minimal settings/config page
- [x] tests for core flows
- [x] README with limitations and deviations

### Phase 2 status: pragmatic subset delivered
- [x] broader common-case PromQL support (`min`, `max`, `last_over_time`, `!=` matching)
- [x] broader common-case LogQL support (`rate`, `count_over_time`, `!=` matching)
- [x] better panel capability via stat panels
- [x] manual scrape control in settings
- [x] persisted alert history
- [x] alert history visible in the UI
- [x] human-readable alert timestamps
- [x] scrape target edit/delete flow
- [x] basic diagnostics summary in settings
- [x] authenticated status page
- [x] `/metrics` endpoint for internal self-observability metrics
- [x] HTML escaping for rendered user-provided values
- [x] internal stable/derived self-loggers with guardrails
- [x] logout flow
- [x] documented deferred deeper post-MVP work in `README.md`

### Validation
- [x] `nix develop -c zig build test`
- [x] `nix build .#default`
- [x] `nix run .#test`

### Current implementation mapping
- **Runtime/build:** `build.zig`, `flake.nix`, and one Zig entrypoint at `src/main.zig` build a single `faceplant` binary.
- **Persistence:** one SQLite database file at `$FACEPLANT_DATA_DIR/faceplant.sqlite` stores config, sessions, dashboards, panels, scrape targets, metric samples, logs, alert rules, current alert state, and alert history.
- **Auth/session flow:** `/login` accepts the shared secret, initializes `instance_secret` when `FACEPLANT_SECRET` is unset, creates a `faceplant_session` cookie, and protects all app/API routes except `/login`, `/api/logs/push`, and `/healthz`.
- **Pages delivered:** `/`, `/dashboard/:id`, `/logs`, `/alerts`, `/settings`, `/status`, `/login`.
- **Mutation/auth routes delivered:** `/login`, `/logout`, `/dashboards/create`, `/dashboard/:id/rename`, `/dashboard/:id/delete`, `/dashboard/:id/panels/create`, `/dashboard/:id/panel/:panel_id/delete`, `/settings/scrape-targets`, `/settings/scrape-target/:id/update`, `/settings/scrape-target/:id/delete`.
- **JSON/text routes delivered:** `/api/metrics/query`, `/api/logs/query`, `/api/logs/push`, `/api/alerts/state`, `/api/admin/scrape`, `/healthz`, `/metrics`.
- **Dashboard capability:** create/rename/delete dashboards; add/remove `metrics`, `logs`, and `stat` panels; Apache ECharts drives metrics charts.
- **Metrics/query subset delivered:** PromQL-style selectors, `=`/`!=` label matching, `sum`, `avg`, `min`, `max`, `rate`, and `last_over_time` over the stored metric samples.
- **Logs/query subset delivered:** Loki-style selectors with `=`/`!=`, line include/exclude filters, log line queries, plus `count_over_time` and `rate` metric-from-logs queries.
- **Alerting delivered:** rules persist in SQLite, background evaluation updates `alert_state`, each evaluation appends to `alert_history`, recent history is visible on the Alerts page, timestamps are rendered in a more readable form, and state transitions emit stable internal self-logs.
- **Operational controls delivered:** scrape targets are managed in Settings, can be edited or deleted, can be triggered immediately via manual scrape, Settings includes a small diagnostics summary, `/status` exposes authenticated runtime counters, `/metrics` exposes internal Prometheus-style counters/gauges, rendered user-provided values are HTML-escaped in the UI, and internal self-logs use stable/derived logger classes with guardrails.

### Remaining intentionally deferred work
- richer dashboard layout editing, duplication, reordering, and resizing
- broader PromQL/LogQL compatibility beyond the pragmatic common-case subset
- notifications and deeper alert debugging UX
- retention, compaction, and more advanced query/storage optimization
- richer diagnostics/admin pages

## Objective
Build `faceplant` as a **single executable** that provides a minimal, self-hosted observability stack with:
- metrics ingestion and querying
- dashboards / graphs
- logs ingestion and querying
- alerting
- a minimal web UI

The intended product is an **all-in-one local tool** that feels like a compact combination of:
- Prometheus
- Grafana
- Loki
- Alloy

However, the emphasis is on:
- low operational overhead
- one executable
- one data directory
- minimal UI
- pragmatic implementation choices

Faceplant should support:
- **PromQL** for metrics queries
- **Loki-style / LogQL-style querying** for logs

Exact edge-case compatibility with upstream Prometheus/Loki behavior is **not required**. Match upstream behavior where it is straightforward. Where exact matching would create major complexity, choose the simplest reasonable implementation and document the difference.

---

## Delivery Strategy
This project should be built in **two phases**.

- **Phase 1 (MVP):** build the smallest version that is genuinely useful.
- **Phase 2 (Post-MVP):** expand compatibility, polish, and operational maturity.

The implementation should focus on completing **Phase 1 first**. Do not drift into Phase 2 work unless Phase 1 is already complete.

---

## Hard Constraints

### Packaging / runtime
- Deliver a **single executable** called `faceplant`.
- It should run with relatively limited CPU and memory.
- It should not require the user to run multiple daemons manually.
- All persistent state must live under **one data directory**.
- Prefer **fewer files** in the data directory.

### Dependencies
Only use these external dependencies unless absolutely required by the language/runtime/toolchain:
- `jetzig`
- `Apache ECharts`

If a dependency is not listed above, avoid it.

### UI constraints
- UI should be intentionally minimal and unstyled.
- Do **not** spend time on visual polish.
- Use only:
  - a `reset.css`
  - plain HTML
  - minimal JavaScript where needed
- No component library, CSS framework, or design system.
- Prioritize clarity and usability over appearance.

### Tooling / Nix
Maintain a `flake.nix` that provides:
- a development shell
- a build for the final executable
- a test app runnable with `nix run .#test`

If any shell tools are needed, add them through Nix.

---

## Query Language Principle

### Metrics queries
Faceplant must support **PromQL** for normal practical use.

### Logs queries
Faceplant must support **Loki-style / LogQL-style querying** for normal practical use.

### Compatibility rule
- Match upstream behavior when it is simple.
- Prioritize common, useful queries over obscure edge cases.
- Document meaningful limitations or deviations.

---

## Authentication

Use an environment variable named `FACEPLANT_SECRET` as the shared secret.

### Required behavior
- If `FACEPLANT_SECRET` is set:
  - the app must require authentication
  - authentication succeeds when the user provides that exact secret
  - on success, set a **secure, HTTP-only cookie**
- If the request is unauthenticated:
  - show a simple login page
  - the page asks only for the secret
- If `FACEPLANT_SECRET` is **not** set:
  - still show the login page
  - allow the user to enter a secret
  - use that secret for the current running instance in a sensible persisted or in-memory way

### Notes
- Keep the auth model deliberately simple.
- Do not build users, roles, password recovery, OAuth, etc.
- Use constant-time comparison where practical.
- Document assumptions around HTTPS, localhost, and secure-cookie behavior.

---

## Functional Scope
The UI and APIs should cover only these areas:
- dashboards
- graphs / panels
- alerts
- logs
- minimal configuration for ingestion

Everything else is out of scope unless required to support those areas.

---

## Architecture Direction

### Preferred strategy
Because PromQL and Loki-style querying are substantial requirements, **prefer reusing or adapting existing implementations/approaches** where feasible rather than reimplementing every language/runtime detail from scratch.

The custom code should focus on:
- packaging everything into one executable
- unified startup/shutdown
- one data directory
- auth/session handling
- metadata storage
- minimal web UI
- orchestration of ingestion, querying, and alert evaluation

### What not to do
- Do not attempt a heroic reimplementation of every PromQL and LogQL semantic detail.
- Do not expand into full Grafana or full Alloy UX.
- Do not spend significant effort on polished frontend architecture.

### Acceptable tradeoff
It is acceptable to implement:
- strong common-case query support in Phase 1
- broader query support in Phase 2
- documented deviations from upstream semantics

as long as the system remains genuinely useful.

---

## Phase 1 (MVP)
Build only the smallest version that proves the product is useful.

### Phase 1 goals
A user should be able to:
1. run one executable
2. log in with a shared secret
3. ingest metrics
4. query metrics with PromQL for ordinary dashboard/alert use
5. ingest logs
6. query logs with Loki-style / LogQL-style syntax for ordinary use
7. create a dashboard
8. add metric and log panels
9. define a simple alert rule
10. view alert state

### Phase 1 required features

#### 1. Authentication
Implement:
- login page
- shared-secret authentication using `FACEPLANT_SECRET`
- secure HTTP-only cookie session
- route protection for app pages

Do not implement:
- user accounts
- roles
- OAuth
- password-reset flows

#### 2. Dashboards
Implement:
- list dashboards
- create dashboard
- rename dashboard
- delete dashboard
- view dashboard
- add and remove panels
- basic simple panel layout

Keep layout simple. No polished editor is required.

#### 3. Panels
Implement at least:
- one **time series metrics panel** using Apache ECharts
- one **logs panel**
- one **stat panel** only if it is easy

For metrics panels:
- support PromQL query input
- support time range selection
- support refresh/polling

For logs panels:
- support Loki-style / LogQL-style query input
- support time range selection
- support refresh

#### 4. Metrics
Implement a minimal but useful metrics pipeline:
- ingest metrics, preferably via scraping Prometheus-style endpoints
- store time-series samples
- execute PromQL for common practical use cases
- power dashboards and alerts from those queries

Phase 1 PromQL target:
- enough support for ordinary selectors, range queries, aggregations, and common functions used in dashboards/alerts
- exact edge-case Prometheus semantics are not required

#### 5. Logs
Implement a minimal but useful logs pipeline:
- ingest logs, preferably via HTTP push
- store logs with labels and timestamps
- execute Loki-style / LogQL-style queries for common practical use cases
- power logs pages and log panels from those queries

Phase 1 logs-query target:
- label selection
- text filtering
- time-range filtering
- common useful query patterns
- basic metric-style aggregations over logs if practical

#### 6. Alerts
Implement a minimal alerting system:
- create alert rules
- evaluate them on a schedule
- show current alert state in the UI
- persist rules and recent alert state/history

Phase 1 alerting can be simple. Notification integrations are not required.

#### 7. Configuration / ingestion management
Implement only what is necessary to use the system:
- configure scrape targets for metrics
- expose log-ingestion endpoint(s)
- provide minimal settings/config UI or config file support

#### 8. Storage
Phase 1 storage must:
- keep all persistent data under one data directory
- use SQLite for structured metadata such as dashboards, alerts, config, and panel definitions
- use SQLite and/or a small number of data files for metrics and logs
- remain simple and durable

#### 9. UI pages
Phase 1 required pages:
- Login
- Dashboard list
- Dashboard detail/view
- Dashboard create/edit flow
- Alerts list
- Logs view
- Basic settings/config page if needed

#### 10. Testing
Phase 1 must include a fast test suite covering:
- auth behavior
- dashboard CRUD
- metrics ingestion
- logs ingestion
- PromQL execution for representative common queries
- Loki-style / LogQL-style query execution for representative common queries
- alert evaluation
- key HTTP routes

### Phase 1 acceptance criteria
Phase 1 is complete when all of the following are true:

1. `faceplant` builds as a single executable.
2. The project can be built and tested via Nix.
3. All persistent data lives in one data directory.
4. Authentication works via `FACEPLANT_SECRET` and secure HTTP-only cookie sessions.
5. A user can log in and access a minimal web UI.
6. A user can create and view dashboards.
7. A dashboard can render at least one metric graph using Apache ECharts.
8. Metrics can be ingested and queried with PromQL for ordinary use cases.
9. Logs can be ingested and queried with Loki-style / LogQL-style queries for ordinary use cases.
10. A user can create alert rules and see current alert state.
11. The UI remains intentionally minimal and largely unstyled.
12. The test suite is fast and covers core functionality and representative query behavior.
13. Documentation clearly describes any meaningful query-language limitations or semantic deviations.

---

## Phase 2 (Post-MVP)
Phase 2 expands compatibility, polish, and operational maturity after Phase 1 is done.

### Phase 2 focus areas

#### 1. Broader PromQL support
Expand support toward stronger practical compatibility, including more of:
- functions
- operators
- vector matching
- subqueries
- more complete aggregation behavior
- improved semantic parity where useful

#### 2. Broader Loki-style / LogQL-style support
Expand support toward stronger practical compatibility, including more of:
- pipeline stages
- parsers / filters / formatting behavior
- richer metric-from-logs queries
- more complete aggregation behavior

#### 3. Better dashboard UX
Improve dashboard usability with features such as:
- better panel editing flows
- panel duplication
- better layout/reordering/resizing
- richer time controls
- better refresh controls

#### 4. More panel capabilities
Potential additions:
- better stat panels
- table-like presentations
- richer legends / axis controls / units
- additional useful panel options

#### 5. Better ingestion / config support
Potential additions:
- richer scrape-target management
- improved ingestion diagnostics
- optional pushed metrics support if not done in Phase 1
- optional file tailing for logs if practical

#### 6. Better alerting depth
Potential additions:
- richer alert history
- better rule editing UX
- notification integrations if simple
- better state visibility and debugging

#### 7. Storage / retention / query maturity
Potential additions:
- better compaction/indexing
- improved retention handling
- better query performance
- improved disk efficiency

#### 8. Better operability
Potential additions:
- diagnostics/status pages
- ingestion health visibility
- internal metrics/debug visibility
- stronger admin/config ergonomics

### Phase 2 non-goals unless they become trivial
Even in Phase 2, avoid drifting into:
- multi-user support
- RBAC
- polished theming systems
- plugin architectures
- distributed clustering
- enterprise feature sets
- exact edge-case Prometheus/Loki compatibility

---

## Storage Requirements
All persistent data must live under one application data directory.

### Persist at minimum
- dashboards
- panel definitions
- alert rules
- alert state / recent history
- auth/session data if needed
- scrape target configuration
- log ingest configuration if needed
- metrics/log storage and indexes

### Preferred storage approach
- Use **SQLite** for structured metadata such as dashboards, alerts, config, and panel definitions.
- Use SQLite for more data if that remains practical.
- Use additional file-backed structures only where there is a clear benefit.
- Prefer a small number of durable files over many scattered files.

---

## API Expectations
Using JavaScript for APIs that back the UI is acceptable if needed.

Expose only the APIs required by:
- UI interactions
- metrics querying
- logs querying
- metrics ingestion
- logs ingestion
- alert CRUD and state
- scrape target/config management

Suggested API groups:
- auth
- dashboards
- panels
- metrics query
- metrics ingest / scrape config
- logs query
- logs ingest
- alerts CRUD / state
- config

Document each route briefly.

---

## Non-Goals
Do **not** build the following unless they are trivial side effects of the implementation:
- multi-user support
- RBAC
- polished theming
- plugin systems
- enterprise features
- clustering / distributed deployments
- advanced notification routing
- full Grafana UX parity
- full Alloy pipeline DSL parity
- exact Prometheus / Loki edge-case compatibility

---

## Research Guidance
If necessary, study existing tools such as:
- VictoriaMetrics
- Prometheus
- Grafana
- Loki
- Alloy

If cloning or inspecting them, place them under `./workdir/` and ensure `workdir/` is gitignored.

Use that research to understand:
- ingestion models
- storage models
- query support strategies
- common compatibility expectations

Do not let research expand the scope beyond the current phase.

Web search and browser-based research are allowed when necessary.

---

## Implementation Expectations
Before implementation, produce a short architecture summary covering:
- executable structure
- startup lifecycle
- storage model
- metrics ingestion path
- logs ingestion path
- PromQL support strategy
- Loki-style query support strategy
- alert evaluation path
- HTTP route layout
- frontend page structure
- testing strategy
- what belongs to Phase 1 vs Phase 2

Implementation should separate concerns at least into:
- storage
- ingestion
- query/evaluation
- alerts
- HTTP/API
- frontend rendering/assets

---

## Testing Requirements
Build a **comprehensive but fast** test suite.

### Must include
- unit tests for storage logic
- unit tests for auth behavior
- unit tests for alert evaluation
- tests for metrics ingestion
- tests for logs ingestion
- tests for PromQL query execution on representative common queries
- tests for Loki-style / LogQL-style query execution on representative common queries
- integration tests for HTTP routes
- integration tests for dashboard CRUD
- integration tests for alerts UI/data flow

### Testing philosophy
- prioritize common, practical query patterns
- include representative compatibility tests
- do not spend disproportionate effort testing obscure upstream edge cases unless easy

### Nix test target
Expose tests via `flake.nix` so this works:

```nix
apps.${system}.test = {
  type = "app";
  program = toString (pkgs.writeShellScript "test" ''
    echo "run your test suite here"
  '');
};
```

Runnable as:

```bash
nix run .#test
```

---

## README Requirements
Include a short `README.md` that covers:
- what Faceplant is
- how to build it
- how to run it
- required environment variables
- authentication behavior
- data directory behavior
- metrics ingestion setup
- logs ingestion setup
- known query-language limitations or deviations
- feature limitations
- what is in Phase 1 vs what is deferred to Phase 2

---

## Implementation Priorities
Build in this order:
1. project skeleton + `flake.nix`
2. storage layer
3. auth flow
4. metrics ingestion + PromQL support strategy
5. logs ingestion + Loki-style query support strategy
6. dashboard CRUD
7. graph/log panel rendering
8. alert rules/evaluation
9. tests
10. README cleanup

Do not work on Phase 2 items until Phase 1 acceptance criteria are met.

---

## Agent Instructions
- Focus on **Phase 1 (MVP)** first.
- Keep scope tight outside the required core capabilities.
- Spend complexity budget on query support, ingestion, and correctness of core flows.
- Do not spend time on visual polish.
- Prefer reuse or adaptation over heroic reimplementation where feasible.
- Match upstream query behavior where it is simple.
- Do not chase obscure edge-case semantics.
- If a feature would require major complexity, implement the smallest useful version that still supports ordinary user workflows and document the limitation.
- Keep resource usage low.
- Keep the architecture understandable and maintainable.
