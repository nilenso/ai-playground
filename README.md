# AI Playground

A repository for small AI experiments and practice building things that use AI.

It is a polyglot monorepo with multiple small services and tools organized in top-level directories.

## Projects

| Project | Description | Stack |
|---------|-------------|-------|
| [megasthenes-web](./megasthenes-web) | Web interface and server around the megasthenes library for querying repositories with an LLM agent | TypeScript, Bun, Hono, React |
| [faceplant](./faceplant) | Single-binary local observability stack with dashboards, metrics scraping/querying, log ingestion/querying, alerts, and a minimal web UI | Zig, SQLite, Nix, Apache ECharts |
| [fivetwo](./fivetwo) | Long-term memory and project tracking for AI coding agents | TypeScript, Bun, Hono |
| [lenso2](./lenso2) | Real-time voice/video meeting assistant | TypeScript, Bun |
| [jadoo](./jadoo) | Slack bot for assorted Nilenso tasks | Mixed |
| [autoresearch](https://github.com/nilenso/autoresearch) | Agent-friendly CLI evaluation and experiment harness, moved to its own repository | Python, uv |

## Notes

- Each project has its own local `README.md` with build and run instructions.
- `faceplant` is a self-contained observability tool built as one executable with one SQLite-backed data directory.
