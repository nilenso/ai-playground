# VocabGym

VocabGym is a small Deno + Hono web app for building a personal vocabulary list with AI-assisted translations, examples,
and nuance notes.

## Stack

- Deno
- Nix dev shell
- Hono
- SQLite via `jsr:@db/sqlite`
- Flue + OpenRouter
- WebAuthn/passkeys only

## Requirements

- `nix develop`
- an OpenRouter API key
- a browser with passkey/WebAuthn support

## Environment

Create a `.env` file at the project root. VocabGym loads `./.env` automatically at startup for local development:

```bash
OPENROUTER_API_KEY=your_openrouter_key
PUBLIC_BASE_URL=http://localhost:8000
DATABASE_PATH=./data/vocabgym.sqlite
PORT=8000
ADMIN_USERNAME=admin
RP_NAME=VocabGym
```

Optional:

```bash
SESSION_COOKIE_NAME=vocabgym_session
SESSION_TTL_DAYS=30
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

## Development

Enter the dev shell first:

```bash
nix develop
```

Run migrations:

```bash
deno task migrate
```

Start the app:

```bash
deno task dev
```

Then open <http://localhost:8000>.

## Tasks

```bash
deno task dev

deno task start

deno task migrate

deno task test

deno task check
```

## Authentication

- passkey-only auth
- no password fallback
- one active passkey per user in v1
- admin resets revoke the stored credential, invalidate sessions, and set `passkey_reset_required`
- after an admin reset, the user must register a new passkey using the same username

The username matching `ADMIN_USERNAME` becomes the admin account when it is first registered.

## Notes

- Default known language: English (`en`)
- Default target language: Portuguese, Brazil (`pt-BR`)
- Search results replace the vocab list area in the UI
- “Back to vocab list” restores the saved list view
- AI search uses OpenRouter model `mistralai/mistral-small-2603` through Flue for faster interactive search latency

## Validation

Run before finishing changes:

```bash
nix develop -c deno fmt --check
nix develop -c deno lint
nix develop -c deno test
nix develop -c deno task check
```
