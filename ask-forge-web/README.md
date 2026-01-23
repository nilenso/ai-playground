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

## Scripts

- `bun run dev` — Start dev server with hot reload
- `bun run build` — Build client bundle
- `bun run check` — Run biome lint/format
