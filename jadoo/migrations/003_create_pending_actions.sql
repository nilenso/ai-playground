-- Pending actions: confirmation flow state machine
-- action_type: 'create_leave' | 'cancel_leave'
-- status: 'pending' | 'confirmed' | 'processing' | 'completed' | 'expired' | 'cancelled'
CREATE TABLE pending_actions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    slack_event_id TEXT,
    slack_message_ts TEXT,
    slack_channel_id TEXT,
    slack_thread_ts TEXT,
    slack_bot_message_ts TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pending_actions_status_expires ON pending_actions(status, expires_at);
CREATE UNIQUE INDEX idx_pending_actions_slack_event_id
    ON pending_actions(slack_event_id)
    WHERE slack_event_id IS NOT NULL;
