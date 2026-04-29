# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A polyglot AI/ML experimentation monorepo using **Bun** runtime and **TypeScript** throughout. Contains:

- **megasthenes-web** - Web UI and server wrapping the [megasthenes](https://github.com/nilenso/megasthenes) library
- **fivetwo** - Long-term memory/project tracking system for AI coding agents
- **lenso2** - Real-time voice/video meeting assistant using Google Gemini API

## Build Commands

All projects use Bun. Run commands from each project's directory.

### megasthenes-web
```bash
bun install
podman-compose up migrate  # Run database migrations (required before first run)
bun run dev                # Dev server with hot reload (builds client + runs server)
bun run build              # Build client bundle + inject cache-busting hash into index.html
bun run check              # Format + lint
```

### fivetwo
```bash
bun install
bun dev              # Dev server with watch mode
bun run tui          # Terminal UI interface
bun test             # Run tests
bun test src/app.test.ts  # Run single test file
```

### lenso2
```bash
bun install
bun run dev          # Dev server with watch mode
bun run tunnel       # Expose via Cloudflare Tunnel (for HTTPS/WebRTC)
```

## Architecture

### Technology Stack
- **Runtime:** Bun (not Node.js)
- **Web Framework:** Hono (not Express)
- **Database:** SQLite via `bun:sqlite`
- **Migrations:** litem8
- **Linting/Formatting:** Biome
- **Testing:** Bun's native `bun:test`

### Key Patterns

**Hono-Based REST APIs:** All web services use Hono with type-safe routes, middleware for logging/CORS/auth, and JWT authentication (fivetwo).

**SQLite with Migrations:** Database schemas live in `migrations/` directories. Use litem8 for versioning.

**WebSocket for Real-time:** megasthenes-web streams LLM responses over WebSocket; lenso2 uses WebSocket for real-time transcription. Use Bun's native WebSocket support (not `ws` library).

**LLM Agent Pattern (megasthenes):** Uses pi-ai framework for agentic loops with tool-use. Max tool iterations configurable (default: 20). System prompts define agent behavior.

**Dual Interfaces (fivetwo):** Supports both React web frontend and Terminal UI (TUI) for the same backend.

### External Dependencies
megasthenes-web depends on the [megasthenes](https://github.com/nilenso/megasthenes) library, published to JSR as `@nilenso/megasthenes`. Updates to megasthenes require bumping the dependency version in megasthenes-web.

## Code Quality

Always run `bun run check` before committing. This invokes Biome for formatting and linting.

Biome configuration (all projects):
- Tab indentation
- 120 character line width
- Recommended lint rules enabled

## Environment

Projects load environment variables from `.env` files automatically. Required variables vary by project (API keys, database paths, ports).

## UI Design Conventions (megasthenes-web)

- **All icons should be pink** (`var(--accent-pink)` / `#ec4899`). This applies to sidebar icons, dropdown menu icons, action buttons, and any other icon elements throughout the UI.

## Git Workflow

- **Always raise PRs** - Never push directly to main. Create a feature branch and open a PR.
- **Check branch status before pushing** - If a PR is already merged, pushing to that branch won't help. Always check if the PR is still open before pushing fixes.
- **Verify remote state** - Run `git pull origin main` and check PR status with `gh pr view <number>` before making changes.

## JSR Packages in Docker

When using JSR packages (like `@nilenso/megasthenes`) in Docker builds:
- The `.npmrc` file must be copied **before** `bun install`
- It configures the JSR npm bridge: `@jsr:registry=https://npm.jsr.io`
- Without this, bun looks at npmjs.org and fails with 404

```dockerfile
# Correct order in Dockerfile
COPY package.json bun.lock .npmrc ./
RUN bun install
```

## Reference Documentation

For Hono framework: `https://hono.dev/llms-full.txt`
