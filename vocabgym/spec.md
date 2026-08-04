# VocabGym Specification

Status: draft v1\
Last updated: 2026-06-11

## 1. Overview

VocabGym is a small web app for building personal vocabulary lists with AI-assisted translations and explanations.

A signed-in user searches for a word or short phrase in a language they already know, chooses a target language, and
gets:

- multiple translation options
- example sentences
- a short explanation of when each option is appropriate
- usage notes for nuance, register, or ambiguity

From those results, the user can save one or more entries into their personal vocabulary list for later studying and
future export to tools like Anki.

The UI is intentionally minimal:

1. a search form at the top
2. the full vocab list below it by default
3. when a search is performed, the results replace the vocab list
4. a clear link/button returns the user to the full vocab list view

## 2. Core goals

- Make vocabulary lookup fast and pleasant.
- Help users understand nuance, not just literal translation.
- Let users save useful words to a persistent personal vocab list.
- Keep authentication simple and secure with passkeys.
- Keep the technical stack small and maintainable.
- Use Deno + Nix for reproducible development.

## 3. Non-goals for v1

These are explicitly out of scope for the first version:

- spaced repetition scheduling
- Anki export/import
- bulk CSV import/export
- pronunciation audio
- offline dictionary support
- collaborative/shared vocab lists
- mobile-native apps
- multiple saved passkeys per user
- advanced tagging, folders, or decks

## 4. Product requirements

### 4.1 Authentication

Users sign in with passkeys.

Requirements:

- Passkey-based authentication only.
- No password login.
- No self-service password or account recovery.
- Each user creates their passkey once during registration/onboarding.
- If the user loses access to that passkey, only an admin can reset passkey access from the backend.
- After an admin reset, the user must register a new passkey before signing in again.

Assumed implementation for v1:

- WebAuthn-based passkey authentication.
- One active passkey credential per user.
- No self-serve “add another device” flow in v1.
- Secure cookie-backed sessions after successful authentication.

### 4.2 Search and translation flow

A signed-in user can:

1. enter a word or short phrase
2. choose the known/source language
3. choose the target language
4. submit the search
5. view multiple translation options with examples and explanations
6. save a chosen option to their vocab list

Behavior:

- Default known language: English (`en`)
- Default target language: Portuguese (Brazil) (`pt-BR`)
- The app should support 20 language options total.
- Search is for short vocabulary-oriented input, not long paragraphs.
- Results should emphasize nuance and practical usage.
- The app should handle ambiguous words by presenting multiple senses/options.

### 4.3 Vocab list

A signed-in user has a personal vocab list.

Requirements:

- Users can save a translation option from search results.
- The vocab list is persistent in SQLite.
- The vocab list shows all saved entries for the current user.
- The default page view after sign-in shows the full vocab list under the search form.
- Search results temporarily replace the vocab list area.
- A visible “Back to vocab list” control returns the user to the full list.

Recommended default list behavior:

- sort by most recently added first
- prevent exact duplicates for the same user when all of these match:
  - source term
  - known/source language
  - target language
  - chosen translation
- allow the same source term to be saved more than once when the translation differs by nuance/sense

## 5. Supported languages

V1 supports these 20 languages for both source and target selection:

1. English (`en`) — default known language
2. Portuguese, Brazil (`pt-BR`) — default target language
3. Spanish (`es`)
4. French (`fr`)
5. German (`de`)
6. Italian (`it`)
7. Dutch (`nl`)
8. Swedish (`sv`)
9. Norwegian Bokmål (`nb`)
10. Danish (`da`)
11. Polish (`pl`)
12. Czech (`cs`)
13. Romanian (`ro`)
14. Greek (`el`)
15. Turkish (`tr`)
16. Russian (`ru`)
17. Arabic (`ar`)
18. Hindi (`hi`)
19. Japanese (`ja`)
20. Mandarin Chinese, Simplified (`zh-CN`)

Notes:

- The same set is available for known/source and target language selection.
- Source and target should not be the same in normal usage; the UI should prevent or warn on identical language pairs.

## 6. AI behavior

AI interactions must use:

- **Flue** for AI orchestration/interactions
- **OpenRouter** as the provider
- model: **`mistralai/mistral-small-2603`**

### 6.1 Search output requirements

For each search, the AI should return structured data that includes:

- normalized source term
- detected or inferred part of speech when possible
- 3–5 translation options when appropriate
- a short explanation for each option
- notes on nuance, register, or context
- one example sentence in the target language for each option
- one explanation or back-translation of the example in the known language
- any caution for false friends, awkward literal translations, or common misuse

### 6.2 Output shape

The application should treat the model response as structured JSON, not free-form markdown.

Suggested shape:

```json
{
	"sourceTerm": "run",
	"normalizedSourceTerm": "run",
	"knownLanguage": "en",
	"targetLanguage": "pt-BR",
	"partOfSpeech": "verb",
	"generalNotes": [
		"This word is highly context-dependent."
	],
	"options": [
		{
			"rank": 1,
			"translation": "correr",
			"register": "neutral",
			"whenToUse": "Use for physical running or jogging.",
			"explanation": "Most common translation for movement on foot at speed.",
			"exampleTarget": "Eu gosto de correr no parque de manhã.",
			"exampleKnown": "I like to run in the park in the morning.",
			"notes": [
				"Not suitable for 'run a company'."
			],
			"confidence": 0.92
		}
	]
}
```

### 6.3 Prompting rules

The system prompt for translation/search should instruct the model to:

- optimize for language learners
- prefer practical, idiomatic translations
- surface ambiguity instead of hiding it
- distinguish between literal translation and natural usage
- avoid unsupported claims about etymology or advanced grammar unless relevant
- return only the requested JSON structure

### 6.4 Model output persistence

Persist only the useful final result fields needed by the app.

Do **not** persist:

- hidden reasoning
- chain-of-thought
- provider-specific debug artifacts unless explicitly needed for diagnostics

## 7. User experience

## 7.1 Main app layout

After sign-in, the main page contains:

- app title/header
- language selectors
- search field
- search submit button
- the content area below

Default content area:

- full vocab list

After a search:

- translation result cards replace the vocab list in the content area
- a “Back to vocab list” link/button is shown

## 7.2 Result cards

Each translation option card should show:

- translated word/phrase
- part of speech if available
- short explanation
- when-to-use guidance
- example in target language
- explanation/back-translation in known language
- save/add button

## 7.3 Vocab list display

Each vocab row/card should show at least:

- source term
- chosen translation
- known language → target language
- short explanation
- example sentence
- date added or relative time

## 7.4 UX principles

- Keep the interface lightweight.
- Prefer server-rendered HTML with minimal client-side JavaScript, except where WebAuthn requires browser APIs.
- Make keyboard usage easy.
- Keep forms accessible and clear.
- Optimize for desktop first, but keep the layout responsive enough for mobile browsers.

## 8. Technical stack

VocabGym is a **Deno project**.

Required stack:

- **Runtime:** Deno
- **Dev environment:** `nix develop` via a flake
- **Web framework:** Hono
- **Storage:** SQLite using the Deno SQLite driver
- **AI:** Flue + OpenRouter provider
- **Model:** `mistralai/mistral-small-2603`

### 8.1 Development environment

The repository should include a Nix flake that provides a dev shell with the tools needed for local development.

For local development, the app may load environment variables from a project-root `.env` file.

Minimum expected tooling in the dev shell:

- Deno
- SQLite CLI
- git
- any small helper tools needed for local development/test scripts

### 8.2 Deno conventions

Recommended project conventions:

- use `deno.json` for tasks and configuration
- use `deno task` for developer commands
- use `deno fmt`, `deno lint`, and `deno test`
- prefer JSR packages where practical

Suggested tasks:

- `deno task dev`
- `deno task start`
- `deno task check`
- `deno task test`
- `deno task migrate`

## 9. Architecture

## 9.1 App shape

A simple monolithic web app is sufficient for v1:

- Hono app serves web pages and JSON endpoints
- SQLite stores users, passkeys, sessions, vocab entries, and admin audit records
- AI translation requests are made server-side through Flue
- Minimal client-side JS is used for passkey registration/authentication and optional progressive enhancement

## 9.2 Suggested route map

### HTML routes

- `GET /` — main app page (redirect to sign-in if unauthenticated)
- `GET /login` — sign-in / registration screen
- `GET /admin` — admin backend page

### Auth routes

- `POST /auth/register/options`
- `POST /auth/register/verify`
- `POST /auth/login/options`
- `POST /auth/login/verify`
- `POST /auth/logout`

### App/API routes

- `GET /api/vocab`
- `POST /api/search`
- `POST /api/vocab`
- `DELETE /api/vocab/:id` (optional but useful for v1)

### Admin routes

- `GET /api/admin/users`
- `POST /api/admin/users/:id/reset-passkey`

## 9.3 Sessions

Use secure session cookies.

Requirements:

- HttpOnly cookies
- Secure in production
- SameSite=Lax or stricter unless a specific flow requires otherwise
- server-side session invalidation on logout

## 10. Data model

Suggested SQLite schema for v1.

### 10.1 `users`

- `id` TEXT PRIMARY KEY
- `username` TEXT UNIQUE NOT NULL
- `display_name` TEXT
- `role` TEXT NOT NULL CHECK(role IN ('admin', 'user'))
- `passkey_reset_required` INTEGER NOT NULL DEFAULT 0
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### 10.2 `passkey_credentials`

- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL
- `credential_id` TEXT UNIQUE NOT NULL
- `public_key` TEXT NOT NULL
- `counter` INTEGER NOT NULL
- `transports_json` TEXT
- `created_at` TEXT NOT NULL
- `last_used_at` TEXT
- `revoked_at` TEXT

Constraints:

- foreign key `user_id` references `users(id)`
- only one active credential per user for v1

### 10.3 `sessions`

- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL
- `expires_at` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `last_seen_at` TEXT NOT NULL
- `user_agent` TEXT
- `ip_hash` TEXT

### 10.4 `vocab_entries`

- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL
- `source_term` TEXT NOT NULL
- `normalized_source_term` TEXT NOT NULL
- `known_language` TEXT NOT NULL
- `target_language` TEXT NOT NULL
- `part_of_speech` TEXT
- `chosen_translation` TEXT NOT NULL
- `register_label` TEXT
- `when_to_use` TEXT
- `explanation` TEXT NOT NULL
- `example_target` TEXT
- `example_known` TEXT
- `notes_json` TEXT
- `model_name` TEXT NOT NULL
- `created_at` TEXT NOT NULL

Suggested uniqueness constraint:

- unique on `(user_id, normalized_source_term, known_language, target_language, chosen_translation)`

### 10.5 `admin_audit_log`

- `id` TEXT PRIMARY KEY
- `admin_user_id` TEXT NOT NULL
- `target_user_id` TEXT
- `action` TEXT NOT NULL
- `metadata_json` TEXT
- `created_at` TEXT NOT NULL

Use this for:

- passkey resets
- role changes
- any future sensitive admin actions

## 11. Admin behavior

Admins need a backend view or endpoint to manage users.

Minimum admin capability for v1:

- list users
- reset a user’s passkey state

Passkey reset behavior:

- revoke/delete the existing credential record
- mark the user as requiring passkey re-registration
- invalidate active sessions for that user
- write an audit log entry

## 12. Security requirements

- Authentication must use WebAuthn/passkeys.
- No plaintext secrets for user login credentials should be stored.
- Session cookies must be secure.
- Admin actions must be authenticated and authorized.
- Admin resets must be logged.
- User input must be validated on the server.
- AI output must be validated against a schema before rendering or saving.
- Rate limiting should be added to auth and search endpoints.

## 13. Error handling

The app should provide simple and understandable errors.

Examples:

- invalid or unsupported search input
- identical known/target language selection
- AI provider error / timeout
- failed passkey verification
- passkey reset required before login

Guidelines:

- show user-friendly messages in the UI
- log detailed server-side errors
- never expose secrets or raw internal stack traces to users

## 14. Suggested implementation structure

One reasonable layout:

```text
vocabgym/
  flake.nix
  deno.json
  AGENTS.md
  spec.md
  migrations/
  src/
    main.ts
    app.ts
    config.ts
    db/
      client.ts
      migrations.ts
    auth/
      webauthn.ts
      sessions.ts
      routes.ts
    ai/
      flue.ts
      prompts.ts
      schema.ts
    vocab/
      routes.ts
      service.ts
      repo.ts
    admin/
      routes.ts
    web/
      pages.tsx
      components/
```

## 15. Acceptance criteria for v1

V1 is complete when all of the following are true:

1. The app runs as a Deno project inside `nix develop`.
2. Hono serves the web app and API routes.
3. SQLite stores users, sessions, passkeys, vocab entries, and admin audit logs.
4. Users can register with a passkey.
5. Users can sign in with that passkey.
6. If a user loses the passkey, an admin can reset passkey access.
7. Users can search for a word/short phrase using AI.
8. Search results provide multiple target-language options with examples and explanations.
9. Users can save a selected translation option to their vocab list.
10. The default UI shows the search form followed by the full vocab list.
11. After searching, results replace the vocab list and a control returns to the list.
12. English is the default known language.
13. Portuguese (Brazil) is the default target language.
14. The app supports the 20 languages listed in this spec.
15. AI requests use Flue + OpenRouter with `mistralai/mistral-small-2603`.

## 16. Assumptions to revisit

These are reasonable v1 assumptions, but we can revise them later:

- Registration is self-serve unless we decide to make it admin-invite-only.
- Users identify themselves with a unique username; email is optional or omitted in v1.
- Only one passkey is allowed per user in v1.
- Search is optimized for single words and short phrases, not full sentences or paragraphs.
- The app is primarily personal/small-scale and does not yet require complex moderation or analytics.

## 17. Companion project instructions

This project should also include an `AGENTS.md` that reflects these choices:

- Deno, not Bun/Node, is the default runtime.
- `nix develop` is the expected development entry point.
- Hono is the required web framework.
- SQLite must use the Deno SQLite driver.
- AI interactions must use Flue with OpenRouter and `mistralai/mistral-small-2603`.
- Authentication is passkey-only, with admin-only reset.
- Developer instructions should include formatting, linting, testing, and migration expectations.

---

If we want, the next step can be turning this spec into:

1. a concrete `flake.nix`
2. a starter `deno.json`
3. a first-pass `AGENTS.md`
4. a migration plan and initial schema
