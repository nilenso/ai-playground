CREATE TABLE share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    share_token TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_share_links_token ON share_links(share_token);
CREATE INDEX idx_share_links_session_id ON share_links(session_id);
