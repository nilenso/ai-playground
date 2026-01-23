-- Create checkouts table to track each commit checkout for a repository
CREATE TABLE checkouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id),
    commit_id TEXT NOT NULL,
    short_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repository_id, commit_id)
);

CREATE INDEX idx_checkouts_repository_id ON checkouts(repository_id);
CREATE INDEX idx_checkouts_commit_id ON checkouts(commit_id);
