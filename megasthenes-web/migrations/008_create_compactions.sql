-- Create compactions table for context compaction records
CREATE TABLE compactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    first_kept_ordinal INTEGER NOT NULL,
    tokens_before INTEGER,
    tokens_after INTEGER,
    read_files TEXT,      -- JSON array of file paths
    modified_files TEXT,  -- JSON array of file paths
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_compactions_session_id ON compactions(session_id);

-- Add compacted flag to messages
ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0;
