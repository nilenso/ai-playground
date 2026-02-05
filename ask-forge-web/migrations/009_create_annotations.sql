-- Create response_annotations table for storing feedback on assistant responses
CREATE TABLE response_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ask_index INTEGER NOT NULL,  -- 0-based index of the ask in the session
    is_relevant BOOLEAN,         -- null = not answered
    is_evidence_supported BOOLEAN,
    is_clear BOOLEAN,
    feedback_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, ask_index)
);

CREATE INDEX idx_response_annotations_session_id ON response_annotations(session_id);
