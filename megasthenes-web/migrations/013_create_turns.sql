-- Create turns table for native megasthenes TurnResult persistence.
-- Each row stores one full TurnResult as JSON, indexed by (session_id, ordinal).
-- This is the canonical source for restoring LLM context via initialTurns.
-- The existing `messages` table is dual-written for one release as a read-side
-- safety net for /sessions/:id/messages, /share/:token, and dump-sessions.
CREATE TABLE turns (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    steps_json TEXT NOT NULL,        -- JSON-serialized TurnResult.steps
    usage_json TEXT NOT NULL,        -- JSON-serialized TurnResult.usage
    metadata_json TEXT NOT NULL,     -- JSON-serialized TurnResult.metadata
    error_json TEXT,                 -- JSON-serialized TurnResult.error or null
    started_at INTEGER NOT NULL,     -- epoch ms
    ended_at INTEGER NOT NULL,       -- epoch ms
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, turn_id),
    UNIQUE (session_id, ordinal)
);

CREATE INDEX idx_turns_session_ordinal ON turns(session_id, ordinal);
