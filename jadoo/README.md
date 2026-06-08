# Jadoo

Extensible Slack bot framework with AI, Google Calendar, and Harvest integrations.

## Setup

```bash
just develop          # or: nix develop 'path:.'
bun install
cp .env.example .env  # fill in your values
```

## Database

Migrations are managed by [litem8](https://github.com/neenaoffline/litem8), a standalone SQLite migration tool.

```bash
# Install litem8 (one-time)
curl -sL https://github.com/neenaoffline/litem8/releases/latest/download/litem8-linux-x86_64-static \
  -o ~/.local/bin/litem8 && chmod +x ~/.local/bin/litem8

# Run pending migrations
bun run migrate

# Check migration status
bun run migrate:status
```

The database path defaults to `./data/jadoo.db` and can be overridden via `DB_PATH` in `.env`.

Migration files live in `migrations/` as plain SQL, named `<number>_<name>.sql`.

## Run

```bash
bun run dev    # with hot reload
bun run start  # production
```

Optional debug logging:

```bash
LEAVE_DEBUG_LOG_ALL_MESSAGES=true bun run dev
```

When enabled, the leave plugin logs every Slack message it sees with whether it matched as an OOO/leave message.

## Test

```bash
bun run test             # unit tests
bun run test:integration # integration tests (needs env vars)
bun run test:all         # everything
```

## Lint / Format

```bash
bun run check
```

## Architecture

### Plugin System

Jadoo is built around a lightweight plugin architecture. The `Bot` class owns the services and orchestrates plugins:

```ts
import { Bot } from "./bot.js";
import type { Plugin } from "./interfaces/plugin.js";

const myPlugin: Plugin = {
  name: "my-plugin",
  init(ctx) {
    // Listen for messages
    ctx.slack.onMessage(async (msg) => {
      if (!msg.text.includes("hello")) return null;
      const response = await ctx.ai.complete({
        messages: [{ role: "user", content: msg.text }],
      });
      return response.content;
    });

    // Handle button clicks
    ctx.slack.onAction(/my_action_.*/, async (event) => {
      await ctx.slack.updateMessage(event.channelId, event.messageTs, {
        text: `Confirmed by <@${event.userId}>`,
      });
    });
  },
  stop() {
    // optional cleanup
  },
};

const bot = new Bot({ ai, calendar, harvest, slack });
bot.register(myPlugin);
await bot.start();
```

Plugins:
- Receive a `BotContext` with all services during `init()`
- Register message handlers and action handlers on `ctx.slack`
- Can use `ctx.ai`, `ctx.calendar`, and `ctx.harvest` freely
- Are initialized in registration order, stopped in reverse
- Cannot be registered after the bot has started

### Service Interfaces

All external services are behind interfaces so they can be mocked in tests:

| Interface | Real Implementation | Mock |
|---|---|---|
| `AIService` | `PiAIService` (pi-ai) | `MockAIService` |
| `SlackService` | `BoltSlackService` (Slack Bolt) | `MockSlackService` |
| `CalendarService` | `GCalService` (@googleapis/calendar) | `MockCalendarService` |
| `HarvestService` | `HarvestAPIService` (REST) | `MockHarvestService` |

The `SlackService` interface is explicitly Slack-specific (not a generic "messaging" abstraction). It exposes:
- **Block Kit**: `postMessage()` with blocks, `updateMessage()` to edit in-place
- **Actions**: `onAction(regex, handler)` for button clicks (ack is handled automatically)
- **Threads**: `getThreadReplies()` for conversation context
- **Users**: `getUserInfo()` for display name, email, timezone

### Database

SQLite via `bun:sqlite`. Three tables:

- **users** — Slack ↔ Harvest ↔ email mapping, timezone
- **leave_records** — date, type (full/half/time-specific), optional start/end time,
  category (vacation/sick), sync status, calendar/harvest IDs
  - See `docs/leave-data-model.md` for the canonical leave-type documentation.
- **pending_actions** — confirmation flow state machine with expiry, JSON payload, thread context

Typed repository functions in `src/db/` — no ORM, plain SQL queries with TypeScript interfaces.

### Configuration

12-factor style — everything via environment variables in a single `.env` file. See `.env.example`.

### Project Structure

```
src/
  bot.ts              # Bot kernel — owns services, orchestrates plugins
  config/             # Env-based config loading
  db/
    database.ts       # openDatabase() + runMigrations()
    types.ts          # DbUser, DbLeaveRecord, DbPendingAction
    users.ts          # User CRUD
    leave-records.ts  # Leave record CRUD + upsert
    pending-actions.ts # Pending action CRUD + expiry
  interfaces/
    ai.ts             # AIService
    slack.ts          # SlackService (Block Kit, actions, threads, user info)
    calendar.ts       # CalendarService
    harvest.ts        # HarvestService
    plugin.ts         # Plugin + BotContext
  services/
    ai/               # pi-ai implementation
    slack/            # Bolt.js SlackService implementation
    calendar/         # Google Calendar implementation
    harvest/          # Harvest REST API implementation
  index.ts            # Entry point
migrations/
  001_create_users.sql
  002_create_leave_records.sql
  003_create_pending_actions.sql
test/
  mocks.ts            # Mock implementations of all interfaces
  db.test.ts          # Database layer tests
  bot.test.ts         # Plugin system tests
  interfaces.test.ts
  config.test.ts
  harvest.test.ts
  integration/        # Tests that hit real APIs (skip when env vars missing)
```
