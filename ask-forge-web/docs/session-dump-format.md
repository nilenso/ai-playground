# Notes

## Session Dump Script (`scripts/dump-sessions.ts`)

The dump script exports ask-forge-web sessions to pi-compatible JSONL files that can be loaded by pi's `SessionManager.open()`.

### Format Compatibility

The output matches pi's session format (version 3):
- Session header with `type: "session"`, `version`, `id`, `timestamp`, `cwd`
- Tree structure with `id` and `parentId` on each entry
- Message entries with proper role-specific fields (`user`, `assistant`, `toolResult`)
- `stopReason: "toolUse"` for assistant messages containing tool calls

### Known Differences

Due to data not being tracked in ask-forge-web's database, the following cannot be included:

1. **No `model_change` entries** - Pi sessions start with a `model_change` entry; we don't track model changes per-session
2. **No `thinking_level_change` entries** - Pi tracks thinking level; we don't store this
3. **Model hardcoded** - Assistant messages use `claude-sonnet-4-20250514` as we don't store the actual model used per-message
4. **Usage stats may be zero** - Only populated if `usage_stats` table has data for the message
5. **cwd is synthetic** - Constructed as `/checkouts/{org}/{repo}` from repository info, not the actual working directory

These differences don't affect pi's ability to load the sessions, but the sessions won't have full fidelity with native pi sessions.
