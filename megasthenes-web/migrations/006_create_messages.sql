-- Create messages table for conversation turns
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
    content TEXT,
    thinking TEXT,
    tool_name TEXT,
    tool_arguments TEXT,
    tool_result TEXT,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, ordinal)
);

CREATE INDEX idx_messages_session_id ON messages(session_id);

-- Create message_feedback table for like/dislike per assistant message
CREATE TABLE message_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    feedback TEXT NOT NULL CHECK(feedback IN ('like', 'dislike')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create usage_stats table for token usage per assistant message
CREATE TABLE usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    inference_time_ms INTEGER NOT NULL
);

CREATE INDEX idx_usage_stats_session_id ON usage_stats(session_id);
