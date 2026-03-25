-- Allowlist for new user signups.
-- Only GitHub usernames present in this table can create an account.
-- Existing users are not affected (they already have a row in `users`).
-- Manage out-of-band:  INSERT INTO allowed_users (github_username) VALUES ('someone');
CREATE TABLE allowed_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
