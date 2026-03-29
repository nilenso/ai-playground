-- Users: maps Slack identities to Harvest and calendar identities
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_user_id TEXT NOT NULL UNIQUE,
    slack_display_name TEXT NOT NULL,
    email TEXT,
    slack_timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    harvest_user_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_slack_user_id ON users(slack_user_id);
CREATE INDEX idx_users_harvest_user_id ON users(harvest_user_id);
