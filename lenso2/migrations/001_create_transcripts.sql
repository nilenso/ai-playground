-- Create transcripts table to store meeting transcription
CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    speaker_name TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Index for efficient queries by room and time
CREATE INDEX IF NOT EXISTS idx_transcripts_room_time ON transcripts(room_id, timestamp);

-- Index for speaker lookups
CREATE INDEX IF NOT EXISTS idx_transcripts_speaker ON transcripts(room_id, speaker_name);

-- Create meetings table to track meeting sessions
CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL UNIQUE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    lenso_active INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_meetings_room ON meetings(room_id);
