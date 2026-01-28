# ask-forge-web

Web interface for asking questions about git repositories.

## Setup

```bash
bun install
```

## Development

```bash
# Build the client
bun run build

# Run the server (with hot reload)
bun run dev
```

## Database Migrations

We use [litem8](https://github.com/neenaoffline/litem8) for SQLite migrations.

### Migration File Format

Create migrations in the `migrations/` directory:

```
<number>_<name>.sql
```

### Run Migrations

```bash
podman-compose up migrate
```

This will run all pending migrations against `data/ask-forge.db`.

### Rules

- Numbers can be zero-padded (`001`) or not (`1`)
- New migrations must have numbers greater than all previously run migrations (no gaps)
- Each migration runs in its own transaction

### Production Deployment

In production, run migrations before the app starts using `depends_on`:

```yaml
services:
  app:
    image: your-app-image
    depends_on:
      migrate:
        condition: service_completed_successfully
    volumes:
      - ./data:/data

  migrate:
    image: ghcr.io/neenaoffline/litem8
    restart: "no"
    volumes:
      - ./migrations:/migrations:ro
      - ./data:/data
    command: up --db /data/ask-forge.db --migrations /migrations
```

The app will only start after migrations complete successfully.

## Session Visualizer

A separate tool for visualizing `.jsonl` session files (e.g., from pi coding agent sessions).

```bash
# Run visualizer (default: looks for .jsonl files in current directory)
bun run dev:visualizer

# Specify a directory containing session files
SESSION_DIR=/path/to/sessions bun run dev:visualizer
```

The visualizer runs on port 3001 and provides:
- Dropdown to select between multiple `.jsonl` files
- Session metadata display (ID, timestamp, working directory)
- Formatted conversation view with user messages, assistant responses, thinking blocks, and tool calls/results

## Scripts

- `bun run dev` — Start dev server with hot reload
- `bun run build` — Build client bundle
- `bun run dev:visualizer` — Start session visualizer (port 3001)
- `bun run build:visualizer` — Build visualizer client bundle
- `bun run check` — Run biome lint/format

## Deployment

The app is deployed to `ask.nilenso.ai` via GitHub Actions.

### CI/CD Pipeline

On push to `main` (when `ask-forge-web/` or `ask-forge/` changes):
1. **Build**: Docker image is built and pushed to `ghcr.io/nilenso/ask-forge-web`
2. **Deploy**: Image is pulled and restarted on the production server

See `.github/workflows/ask-forge-web-docker.yml` for the workflow.

### Manual Deployment

```bash
ssh root@ask.nilenso.ai
cd ~/ask-forge-web
docker compose pull
docker compose up -d
```

### Server Setup

See `deploy/README.md` for initial server provisioning and setup instructions.
