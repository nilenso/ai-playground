-- Leave records: one row per user per leave day
-- leave_type: 'full' | 'half_am' | 'half_pm'
-- leave_category: 'vacation' | 'sick'
-- status: 'pending' | 'confirmed' | 'completed' | 'failed' | 'cancelled'
CREATE TABLE leave_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    leave_type TEXT NOT NULL DEFAULT 'full',
    leave_category TEXT NOT NULL DEFAULT 'vacation',
    slack_message_ts TEXT,
    slack_channel_id TEXT,
    calendar_event_id TEXT,
    harvest_entry_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
);

CREATE INDEX idx_leave_records_user_date ON leave_records(user_id, date);
CREATE INDEX idx_leave_records_status ON leave_records(status);
