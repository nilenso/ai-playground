# fivetwo

An experiment in long term memory for AI coding agents. Closely modelled around
traditional software project management tooling. We'll have to see how that
works out.

### What's with the name?

1. The project models work as story 'cards'. There are fifty two cards in a typical playing card deck.
2. Oftentimes, personal goal setting is done around the 52 weeks of a year. eg. 52 book clubs etc.
3. What are the 2 numbers that follow 5?

## Installation

```bash
bun install
```

## Configuration

Create a config file with a secure random JWT secret:

```bash
bun run mkconfig
```

This creates `fivetwo.config.json` in the current directory with:
- `db`: Path to the SQLite database (relative to config file or absolute)
- `jwtSecret`: Auto-generated secure random secret (min 32 characters)

## Database Migrations

Run migrations to set up the database schema:

```bash
nix run github:neenaoffline/litem8 -- up --db data.db --migrations ./migrations
```

## CLI Commands

```
Usage: bun src/index.ts <command> [options]

Commands:
  mkconfig          Create a new fivetwo.config.json in the current directory
  mkhuman <name>    Create a human user
  mkagent <name>    Create an AI agent user
  auth <username>   Generate a JWT token for the specified user
  serve             Start the server (default if no command given)

Options:
  --config <path>   Path to config file (default: fivetwo.config.json)
```

### Examples

```bash
# Create config file
bun run mkconfig

# Create users
bun run mkhuman alice
bun run mkagent bot

# Generate a JWT for a user
bun run auth alice

# Start the server
bun dev
```

## Running

Development server with hot reload:

```bash
bun dev
```

Production:

```bash
bun start
```

## Terminal UI (TUI)

fivetwo includes an htop-style terminal interface for browsing and managing cards.

**Note:** The TUI requires a real interactive terminal (TTY) to run. It won't work in non-interactive environments like CI pipelines or editor terminals without proper TTY support.

### Running the TUI

```bash
FIVETWO_TOKEN=$(cat neenaauth.token) bun run tui
```

Or set the environment variable:

```bash
export FIVETWO_TOKEN=$(bun run auth <username>)
bun run tui
```

### Keyboard Shortcuts

| Key       | Action                          |
|-----------|---------------------------------|
| `↑`/`↓`   | Navigate cards                  |
| `←`/`→`   | Switch between projects         |
| `/`       | Search/filter cards             |
| `p`       | Open project picker             |
| `Enter`   | View card details               |
| `Escape`  | Close search/picker             |
| `q`       | Quit                            |

### Environment Variables

| Variable        | Description                              | Default                 |
|-----------------|------------------------------------------|-------------------------|
| `FIVETWO_URL`   | API base URL                             | `http://localhost:3000` |
| `FIVETWO_TOKEN` | JWT authentication token (required)      | -                       |

## Authentication

All `/api/*` routes require JWT authentication. Tokens expire after 1 week.

Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/status
```

## API Reference

### Status

#### `GET /api/v1/status`

Returns server status.

```json
{ "status": "ok", "timestamp": "2025-01-01T00:00:00.000Z" }
```

### User

#### `GET /api/v1/user`

Returns the authenticated user's information.

```json
{
  "id": 1,
  "username": "alice",
  "type": "human",
  "email": null,
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

### Projects

#### `GET /api/v1/projects`

List projects. Supports optional filters:

| Query Param  | Description          |
|--------------|----------------------|
| `id`         | Filter by project ID |
| `host`       | Filter by host       |
| `owner`      | Filter by owner      |
| `repository` | Filter by repository |

#### `POST /api/v1/projects`

Create a new project.

```json
{
  "host": "github.com",
  "owner": "myorg",
  "repository": "myrepo"
}
```

#### `GET /api/v1/projects/:id/references`

List all card references within a project. Supports optional `type` filter.

### Cards

#### `GET /api/v1/cards`

List cards. Supports filters and full-text search:

| Query Param  | Description                              |
|--------------|------------------------------------------|
| `id`         | Filter by card ID                        |
| `project_id` | Filter by project                        |
| `status`     | Filter by status                         |
| `priority`   | Filter by priority                       |
| `type`       | Filter by type                           |
| `search`     | Full-text search (title and description) |

**Valid statuses:** `backlog`, `in_progress`, `review`, `blocked`, `done`, `wont_do`, `invalid`

**Valid types:** `story`, `bug`, `task`, `epic`, `spike`, `chore`

#### `POST /api/v1/cards`

Create a new card.

```json
{
  "project_id": 1,
  "title": "Implement feature X",
  "description": "Optional description",
  "status": "backlog",
  "priority": 50,
  "type": "task"
}
```

Required: `project_id`, `title`

**Priority:** 0-100 (higher = more important, default: 50)

#### `PATCH /api/v1/cards/:id`

Update a card. Supports optimistic locking via `version` field.

```json
{
  "title": "Updated title",
  "status": "in_progress",
  "version": 1
}
```

Returns `409 Conflict` with `current_version` if version mismatch.

### Comments

#### `GET /api/v1/cards/:id/comments`

List comments for a card.

#### `POST /api/v1/cards/:id/comments`

Add a comment to a card.

```json
{ "message": "This is a comment" }
```

#### `DELETE /api/v1/comments/:id`

Soft delete a comment (sets status to `deleted`).

### Card References

References link cards together with typed relationships.

**Valid reference types:** `blocks`, `blocked_by`, `relates_to`, `duplicates`, `duplicated_by`, `parent_of`, `child_of`, `follows`, `precedes`, `clones`, `cloned_by`

#### `GET /api/v1/cards/:id/references`

List references for a card. Returns `outgoing` (this card → others) and `incoming` (others → this card).

#### `POST /api/v1/cards/:id/references`

Create a reference from this card to another.

```json
{
  "target_card_id": 2,
  "reference_type": "blocks"
}
```

#### `DELETE /api/v1/cards/:id/references/:refId`

Delete a reference.
