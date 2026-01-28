# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A polyglot AI/ML experimentation monorepo using **Bun** runtime and **TypeScript** throughout. Contains:

- **ask-forge** - Library for safely querying remote git repositories using LLM agents
- **ask-forge-web** - Web UI and server wrapping ask-forge
- **fivetwo** - Long-term memory/project tracking system for AI coding agents
- **lenso2** - Real-time voice/video meeting assistant using Google Gemini API

## Build Commands

All projects use Bun. Run commands from each project's directory.

### ask-forge
```bash
bun install
bun run check        # Format + lint with auto-fix (Biome)
bun run web          # Run web server on port 3000
```

### ask-forge-web
```bash
bun install
podman-compose up migrate  # Run database migrations (required before first run)
bun run dev                # Dev server with hot reload (builds client + runs server)
bun run build              # Build client bundle only
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

**WebSocket for Real-time:** ask-forge-web streams LLM responses over WebSocket; lenso2 uses WebSocket for real-time transcription. Use Bun's native WebSocket support (not `ws` library).

**LLM Agent Pattern (ask-forge):** Uses pi-ai framework for agentic loops with tool-use. Max tool iterations configurable (default: 20). System prompts define agent behavior.

**Dual Interfaces (fivetwo):** Supports both React web frontend and Terminal UI (TUI) for the same backend.

### Local Dependencies
ask-forge-web depends on ask-forge via local file reference (`file:../ask-forge`). Changes to ask-forge require rebuilding ask-forge-web.

## Code Quality

Always run `bun run check` before committing. This invokes Biome for formatting and linting.

Biome configuration (all projects):
- Tab indentation
- 120 character line width
- Recommended lint rules enabled

## Environment

Projects load environment variables from `.env` files automatically. Required variables vary by project (API keys, database paths, ports).

## Reference Documentation

For Hono framework: `https://hono.dev/llms-full.txt`
