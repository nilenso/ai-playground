-- Create sessions table for conversation sessions
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    repository_id INTEGER NOT NULL REFERENCES repositories(id),
    checkout_id INTEGER REFERENCES checkouts(id),
    title TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_repository_id ON sessions(repository_id);
CREATE INDEX idx_sessions_status ON sessions(status);
