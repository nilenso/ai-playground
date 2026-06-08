Default to using Bun instead of Node.js.

> **Note**: When changing behavior, workflows, schema, migrations, or setup steps, update `README.md` accordingly.

- Use `bun install` instead of `npm install` / `yarn` / `pnpm`
- Use `bun run <script>` instead of `npm run <script>` / `yarn run` / `pnpm run`
- Use `bun test` for tests
- Bun automatically loads `.env`, so don't add dotenv unless there is a strong reason

## Required validation after code changes

After making code changes in `jadoo`, run these checks yourself before finishing:

1. `~/.bun/bin/bun test test/*.test.ts`
2. `~/.bun/bin/bun x @biomejs/biome check .`

If Biome reports formatting issues, fix them before finishing.
If you change migrations, parsing, worker logic, or Slack interaction flows, make sure the relevant tests are updated or added.

## Project notes

- Runtime: **Bun**
- Web framework: **Hono**
- Database: SQLite via `bun:sqlite`
- Migrations: `litem8`
- Formatting/linting: **Biome**
- Testing: `bun:test`

## Leave workflow notes

- Prefer Slack Block Kit buttons for ambiguous leave flows rather than asking users for open-ended follow-up text.
- Keep worker, parser schema, persistence, and tests aligned when adding new leave types or payload fields.
- Do not edit already-applied migration files to update comments or documentation. Document schema behavior in `README.md` or `docs/leave-data-model.md`, and use a new migration for real schema changes.
