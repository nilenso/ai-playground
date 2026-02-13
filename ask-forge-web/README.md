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

A tool for visualizing ask-forge sessions stored in the SQLite database.

```bash
bun run dev:visualizer
```

The visualizer runs on port 3001 and provides:
- Sidebar with searchable session list and status filtering (active/inactive/error)
- Session metadata display (repo, commit, timestamp, duration)
- Formatted conversation view with user messages, assistant responses, and tool calls/results
- Annotations for rating response quality (relevance, evidence, clarity)
- Export to JSONL format

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
