# Context Compaction

When conversations grow too long and exceed the model's context window, ask-forge-web automatically compacts older messages into a summary.

## How It Works

1. **Trigger**: Before each `ask()`, we estimate context tokens. If `tokens > contextWindow - reserveTokens`, compaction triggers.

2. **Cut Point**: Find where to split - keeps recent ~20k tokens, summarizes the rest. Cuts at user message boundaries when possible; for very long single turns, can cut mid-turn at assistant messages.

3. **Summarization**: Call Claude to generate a structured summary of older messages, tracking:
   - Goal, progress, key decisions
   - Files read and modified
   - Context needed to continue

4. **Replace**: Old messages are marked `compacted=1` in DB. Summary + recent messages become the new context.

5. **Persist**: Compaction record saved to `compactions` table with summary and metadata.

## Database Schema

### `compactions` table
```sql
CREATE TABLE compactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    first_kept_ordinal INTEGER NOT NULL,  -- messages >= this are kept
    tokens_before INTEGER,
    tokens_after INTEGER,
    read_files TEXT,      -- JSON array
    modified_files TEXT,  -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `messages` table addition
```sql
ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0;
```

## Configuration

```typescript
const DEFAULT_SETTINGS = {
    enabled: true,
    reserveTokens: 16384,      // Reserve for LLM response
    keepRecentTokens: 20000,   // Recent tokens to keep
    contextWindow: 200000,     // Model context size
};
```

## Session Restore

On restore, we check for compaction:
```typescript
const compaction = getLatestCompaction(sessionId);
const messages = compaction 
    ? getNonCompactedMessages(sessionId)  // WHERE compacted = 0
    : getMessagesBySession(sessionId);
const context = buildSessionContext(messages, compaction);  // Prepends summary
```

## Manual Compaction

Use `/compact [instructions]` to manually trigger:
```
/compact
/compact Focus on the API changes
```

## Split Turns

When a single turn exceeds the budget, we generate two summaries:
1. **History summary**: Previous complete turns
2. **Turn prefix summary**: Early part of the split turn

These are merged: `{history}\n\n---\n\n**Turn Context:**\n\n{prefix}`

## Pi JSONL Export

The dump script exports compactions as pi-compatible `CompactionEntry`:
```json
{"type": "compaction", "id": "...", "parentId": "...", "summary": "...", "firstKeptEntryId": "...", "tokensBefore": 150000}
```

## Error Handling

If compaction fails (e.g., API error), the session is marked as `error` and terminated. This prevents context overflow on the subsequent ask.
