# Jadoo — TODO

Gap analysis from comparing Jadoo's current plugin architecture against the [leavebot](../../leavebot/) Python project.

Reference: `../../leavebot/doc/leave-bot-tech-spec.md` for full spec.

---

## Priority order for leave plugin

### ~~1. Harvest interface + service~~ ✅ DONE
- ~~New `HarvestService` interface (create/delete time entries, get users)~~
- ~~Implementation using Harvest REST API (`https://api.harvestapp.com/v2`)~~
- ~~Mock for tests~~
- ~~Config: `HARVEST_ACCESS_TOKEN`, `HARVEST_ACCOUNT_ID`, `HARVEST_PROJECT_ID`, `HARVEST_VACATION_TASK_ID`, `HARVEST_SICK_TASK_ID`~~

### ~~2. Database layer~~ ✅ DONE
- ~~SQLite via `bun:sqlite` with plain SQL migrations (monorepo convention)~~
- ~~Tables: `users`, `leave_records`, `pending_actions`~~
- ~~Typed repository functions for all CRUD operations~~
- ~~Unique constraint: one leave record per user per day~~
- ~~Dedupe on Slack event ID (unique partial index on pending_actions)~~
- ~~26 database tests against in-memory SQLite~~

### ~~3. Richer SlackService~~ ✅ DONE
- ~~Replaced generic `MessagingService` with Slack-specific `SlackService` interface~~
- ~~Block Kit: `postMessage()` with blocks, `updateMessage()` to edit in-place~~
- ~~Actions: `onAction(regex, handler)` for button clicks (ack handled automatically)~~
- ~~Threads: `getThreadReplies()` for conversation context~~
- ~~Users: `getUserInfo()` for display name, email, timezone~~
- ~~Renamed `BoltMessagingService` → `BoltSlackService`, `BotContext.messaging` → `BotContext.slack`~~
- ~~`MockSlackService` with `simulateAction()`, `addUser()`, `addThreadReplies()` test helpers~~

### ~~4. Structured AI output~~ ✅ DONE
- ~~`completeStructured<T>(request, schema): Promise<T>` added to `AIService`~~
- ~~TypeBox schema → system prompt → JSON extraction → validation~~
- ~~Retry with error feedback (configurable `maxRetries`, default 1)~~
- ~~`MockAIService` supports `structuredResponses` queue~~

### ~~5. Background worker~~ ✅ DONE
- ~~`BackgroundWorker` class with two polling loops (process + expiry)~~
- ~~Action processor: claims confirmed → syncs Calendar + Harvest → updates Slack~~
- ~~Expiry sweeper: marks stale pending actions expired, disables Slack buttons~~
- ~~Retry with configurable `maxRetries` per leave record~~
- ~~Supports `create_leave` and `cancel_leave` action types~~
- ~~Wired into `index.ts` with graceful shutdown~~

### ~~6. Google Calendar auth format~~ ✅ DONE
- ~~Supports both formats: `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (preferred) and individual `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`~~
- ~~Base64 JSON takes precedence when both are set~~
- ~~Clear error messages for malformed base64, invalid JSON, missing fields~~

### ~~7. Plugin-scoped config~~ ✅ DONE
- ~~Plugins declare `configSchema` mapping logical keys → env vars (with required/optional/default)~~
- ~~Bot resolves and validates at start time, fails fast on missing required fields~~
- ~~Resolved `PluginConfig` passed as second arg to `init(ctx, config)`~~
- ~~`resolvePluginConfig()` utility accepts custom env source for testability~~
- ~~Bot constructor accepts `{ env }` option to override `process.env` in tests~~

---

## Out of scope (for now)

- Web admin interface (user management, leave history, health dashboard)
- Google OAuth for admin auth
- Caddy / reverse proxy setup
- CI/CD pipeline
- Docker deployment
- Monitoring / alerting / structured logging

---

## What already works

- ✅ Slack Socket Mode via Bolt.js (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`)
- ✅ Google Calendar via `@googleapis/calendar` (`GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID`)
- ✅ AI via pi-ai (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`)
- ✅ Plugin architecture with `BotContext` (ai, calendar, messaging)
- ✅ All interfaces are mockable + tested
- ✅ 12-factor config from `.env`
