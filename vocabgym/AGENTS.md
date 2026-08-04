# AGENTS.md

VocabGym is a **Deno** project.

## Default toolchain

- Use `nix develop` before running project commands.
- Use **Deno**, not Bun, Node.js, npm, pnpm, or yarn.
- Use `deno task <name>` for project workflows.
- Use `deno fmt`, `deno lint`, and `deno test` for validation.

> If you change setup steps, tasks, auth flows, migrations, or architecture assumptions, update `README.md` and
> `spec.md` too.

## Required stack

- **Runtime:** Deno
- **Dev environment:** Nix flake / `nix develop`
- **Web framework:** Hono
- **Database:** SQLite via the Deno SQLite driver
- **AI:** Flue
- **AI provider:** OpenRouter
- **AI model:** `mistralai/mistral-small-2603`

Do not swap these defaults without updating the docs and explaining why.

## Web framework

Use **Hono** for HTTP routing and middleware.

- Prefer a simple monolithic Hono app.
- Prefer server-rendered HTML or minimal client-side JavaScript.
- Client-side browser APIs are acceptable where required for WebAuthn/passkeys.

## Database

Use SQLite with the Deno SQLite driver.

Guidelines:

- Keep schema changes in migrations.
- Do not edit already-applied migrations except in throwaway local work.
- Add a new migration for real schema changes.
- Keep schema, repository code, and tests in sync.

## Authentication

Authentication is **passkey-only**.

Requirements:

- Use WebAuthn/passkeys.
- No password fallback.
- No self-service recovery flow.
- If a user loses the passkey, only an admin can reset it.
- Admin resets must invalidate active sessions and be audit-logged.

Be careful when changing auth code, session code, or admin reset behavior.

## AI usage

All AI interactions must use:

- **Flue**
- **OpenRouter** provider
- model **`mistralai/mistral-small-2603`**

Guidelines:

- Prefer structured outputs validated against a schema.
- Do not persist chain-of-thought or hidden reasoning.
- Store only the final fields needed by the app.

## Project behavior

The core product flow is:

- signed-in user searches for a word/short phrase
- app returns multiple translations with examples and explanations
- user can save one or more options into a personal vocab list

UI expectations:

- search form on top
- full vocab list below by default
- search results replace the list
- user can return to the full vocab list with a clear control

Defaults:

- known language: English (`en`)
- target language: Portuguese, Brazil (`pt-BR`)

## Validation after changes

After making code changes, run the relevant checks yourself before finishing:

1. `nix develop -c deno fmt --check`
2. `nix develop -c deno lint`
3. `nix develop -c deno test`
4. any project-specific task such as `nix develop -c deno task check`

If formatting or linting fails, fix it before finishing. If you change auth, migrations, DB access, or AI output shapes,
update or add tests.

## General guidance

- Prefer small, clear modules.
- Validate all server input.
- Validate AI output before rendering or storing it.
- Keep admin-only operations explicit and audited.
- Use JSR packages where practical.
- Keep the implementation aligned with `spec.md` unless the spec is intentionally revised.
