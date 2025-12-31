import { Database } from "bun:sqlite";

// Initialize database
const db = new Database("./lenso.db");

// Transcript entry type
export interface TranscriptEntry {
	id: number;
	room_id: string;
	speaker_name: string;
	content: string;
	timestamp: number;
	created_at: string;
}

// Meeting type
export interface Meeting {
	id: number;
	room_id: string;
	started_at: number;
	ended_at: number | null;
	lenso_active: number;
}

// Add a transcript entry
export function addTranscript(roomId: string, speakerName: string, content: string): TranscriptEntry {
	const timestamp = Date.now();
	const stmt = db.prepare(`
    INSERT INTO transcripts (room_id, speaker_name, content, timestamp)
    VALUES (?, ?, ?, ?)
  `);
	const result = stmt.run(roomId, speakerName, content, timestamp);

	return {
		id: Number(result.lastInsertRowid),
		room_id: roomId,
		speaker_name: speakerName,
		content: content,
		timestamp: timestamp,
		created_at: new Date().toISOString(),
	};
}

// Get transcripts for a room
export function getTranscripts(roomId: string, limit = 100): TranscriptEntry[] {
	const stmt = db.prepare(`
    SELECT * FROM transcripts
    WHERE room_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
	return stmt.all(roomId, limit) as TranscriptEntry[];
}

// Get transcripts within a time range (e.g., last 15 minutes)
export function getTranscriptsSince(roomId: string, sinceTimestamp: number): TranscriptEntry[] {
	const stmt = db.prepare(`
    SELECT * FROM transcripts
    WHERE room_id = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `);
	return stmt.all(roomId, sinceTimestamp) as TranscriptEntry[];
}

// Get transcripts by speaker
export function getTranscriptsBySpeaker(roomId: string, speakerName: string): TranscriptEntry[] {
	const stmt = db.prepare(`
    SELECT * FROM transcripts
    WHERE room_id = ? AND speaker_name LIKE ?
    ORDER BY timestamp ASC
  `);
	return stmt.all(roomId, `%${speakerName}%`) as TranscriptEntry[];
}

// Get all transcripts for a room (for full meeting summary)
export function getAllTranscripts(roomId: string): TranscriptEntry[] {
	const stmt = db.prepare(`
    SELECT * FROM transcripts
    WHERE room_id = ?
    ORDER BY timestamp ASC
  `);
	return stmt.all(roomId) as TranscriptEntry[];
}

// Create or get a meeting
export function getOrCreateMeeting(roomId: string): Meeting {
	const existing = db.prepare(`SELECT * FROM meetings WHERE room_id = ?`).get(roomId) as Meeting | null;
	if (existing) return existing;

	const stmt = db.prepare(`
    INSERT INTO meetings (room_id, started_at, lenso_active)
    VALUES (?, ?, 0)
  `);
	const result = stmt.run(roomId, Date.now());

	return {
		id: Number(result.lastInsertRowid),
		room_id: roomId,
		started_at: Date.now(),
		ended_at: null,
		lenso_active: 0,
	};
}

// Update Lenso active status
export function setLensoActive(roomId: string, active: boolean): void {
	db.prepare(`UPDATE meetings SET lenso_active = ? WHERE room_id = ?`).run(active ? 1 : 0, roomId);
}

// Check if Lenso is active for a room
export function isLensoActive(roomId: string): boolean {
	const meeting = db.prepare(`SELECT lenso_active FROM meetings WHERE room_id = ?`).get(roomId) as {
		lenso_active: number;
	} | null;
	return meeting?.lenso_active === 1;
}

// End a meeting
export function endMeeting(roomId: string): void {
	db.prepare(`UPDATE meetings SET ended_at = ? WHERE room_id = ?`).run(Date.now(), roomId);
}

// Format transcripts for Gemini context
export function formatTranscriptsForContext(transcripts: TranscriptEntry[]): string {
	return transcripts
		.map((t) => {
			const time = new Date(t.timestamp).toLocaleTimeString();
			return `[${time}] ${t.speaker_name}: ${t.content}`;
		})
		.join("\n");
}

export default db;
