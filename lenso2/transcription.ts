import { Database } from "bun:sqlite";
import type { WSContext } from "hono/ws";

// Initialize database reference (will be set from index.ts)
let db: Database;
let geminiApiKey: string;

export function setDatabase(database: Database) {
	db = database;
}

export function setGeminiApiKey(apiKey: string) {
	geminiApiKey = apiKey;
}

// Room state management
export interface Room {
	id: string;
	meetingId?: number;
	transcriptionActive: boolean;
	audioBuffer: Uint8Array[];
	lastProcessedTime: number;
	lastSpeechTime: number;
	hasSpeech: boolean;
}

export const rooms = new Map<string, Room>();

// Gemini API helpers
export async function transcribeAudioWithGemini(audioData: Uint8Array): Promise<string> {
	try {
		// Convert PCM to WAV format with proper headers
		const wavBuffer = createWavBuffer(audioData, 16000, 1); // 16kHz, mono
		const base64Audio = Buffer.from(wavBuffer).toString('base64');
		
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: `Transcribe the human speech in this audio clip. Return ONLY the spoken words with no additional commentary. If there is no clear speech, return an empty response - do NOT return messages like "nothing", "no speech detected", "[silence]", or any other placeholder text.`
						}, {
							inline_data: {
								mime_type: "audio/wav",
								data: base64Audio
							}
						}]
					}]
				})
			}
		);

		const data = await response.json();
		
		// Try different response structures
		if (data.candidates && data.candidates[0]) {
			const candidate = data.candidates[0];
			
			// Structure 1: content.parts[0].text
			if (candidate.content?.parts?.[0]?.text) {
				const text = candidate.content.parts[0].text.trim();
				console.log(`[GEMINI] Transcription result: "${text}"`);
				return text;
			}
			
			// Structure 2: content is array
			if (Array.isArray(candidate.content) && candidate.content[0]?.text) {
				const text = candidate.content[0].text.trim();
				console.log(`[GEMINI] Transcription result: "${text}"`);
				return text;
			}
			
			// Structure 3: direct text property
			if (candidate.text) {
				const text = candidate.text.trim();
				console.log(`[GEMINI] Transcription result: "${text}"`);
				return text;
			}
			
			// Structure 4: Empty content (no speech detected by Gemini)
			if (candidate.content && Object.keys(candidate.content).length <= 1) {
				console.log('[GEMINI] Empty response - no speech detected by model');
				return "";
			}
		}
		
		console.error('[GEMINI] Unexpected response structure:', JSON.stringify(data, null, 2));
		return "";
	} catch (error) {
		console.error('[GEMINI] Error:', error);
		return "";
	}
}

// Helper function to create WAV file buffer from raw PCM data
function createWavBuffer(pcmData: Uint8Array, sampleRate: number, numChannels: number): Uint8Array {
	const dataSize = pcmData.length;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	
	// WAV header
	// "RIFF" chunk descriptor
	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true); // File size - 8
	writeString(view, 8, 'WAVE');
	
	// "fmt " sub-chunk
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
	view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
	view.setUint16(22, numChannels, true); // NumChannels
	view.setUint32(24, sampleRate, true); // SampleRate
	view.setUint32(28, sampleRate * numChannels * 2, true); // ByteRate
	view.setUint16(32, numChannels * 2, true); // BlockAlign
	view.setUint16(34, 16, true); // BitsPerSample
	
	// "data" sub-chunk
	writeString(view, 36, 'data');
	view.setUint32(40, dataSize, true); // Subchunk2Size
	
	// Copy PCM data
	const uint8View = new Uint8Array(buffer);
	uint8View.set(pcmData, 44);
	
	return uint8View;
}

function writeString(view: DataView, offset: number, str: string) {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}

export async function generateMeetingSummary(meetingId: number): Promise<string> {
	try {
		console.log(`[GEMINI] Generating summary for meeting ${meetingId}`);
		
		// Get all transcriptions for this meeting
		const transcriptions = getTranscriptions(meetingId);
		
		if (transcriptions.length === 0) {
			console.log(`[GEMINI] No transcriptions found for meeting ${meetingId}`);
			return "";
		}
		
		// Combine all transcriptions into one text
		const fullTranscript = transcriptions.join('\n\n');
		console.log(`[GEMINI] Summarizing ${transcriptions.length} transcriptions (${fullTranscript.length} chars)`);
		
		// Send to Gemini for summarization
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: `You are a meeting summarization assistant. Summarize the following meeting transcript. Include:
1. Key points discussed
2. Decisions made
3. Action items (if any)
4. Next steps (if any)

Format the summary in clear, concise bullet points.

Meeting Transcript:
${fullTranscript}`
						}]
					}]
				})
			}
		);

		const data = await response.json();
		
		if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
			const summary = data.candidates[0].content.parts[0].text;
			console.log(`[GEMINI] Generated summary: ${summary.substring(0, 100)}...`);
			
			// Save summary to database
			saveSummary(meetingId, summary);
			
			return summary;
		}
		
		console.error('[GEMINI] Unexpected response:', data);
		return "";
	} catch (error) {
		console.error('[GEMINI] Error generating summary:', error);
		return "";
	}
}

// Database helper functions
export function createMeeting(roomId: string): number {
	const stmt = db.prepare("INSERT INTO meetings (room_id, started_at, participant_count) VALUES (?, ?, ?)");
	const result = stmt.run(roomId, Date.now(), 0);
	console.log(`[DB] Created meeting ${result.lastInsertRowid} for room ${roomId}`);
	return result.lastInsertRowid as number;
}

export function saveTranscription(meetingId: number, transcriptionText: string) {
	const stmt = db.prepare("INSERT INTO transcriptions (meeting_id, transcription_text, created_at) VALUES (?, ?, ?)");
	stmt.run(meetingId, transcriptionText, Date.now());
	console.log(`[DB] Saved transcription for meeting ${meetingId}`);
}

export function endMeeting(meetingId: number, participantCount: number) {
	const stmt = db.prepare(`
		UPDATE meetings 
		SET ended_at = ?, 
		    participant_count = ?,
		    duration_seconds = (? - started_at) / 1000
		WHERE id = ?
	`);
	const now = Date.now();
	stmt.run(now, participantCount, now, meetingId);
	console.log(`[DB] Ended meeting ${meetingId}`);
}

export function getTranscriptions(meetingId: number): string[] {
	const stmt = db.prepare(`
		SELECT transcription_text 
		FROM transcriptions 
		WHERE meeting_id = ? 
		ORDER BY created_at ASC
	`);
	const rows = stmt.all(meetingId) as Array<{ transcription_text: string }>;
	return rows.map(row => row.transcription_text);
}

export function saveSummary(meetingId: number, summaryText: string) {
	const stmt = db.prepare("INSERT INTO meeting_summaries (meeting_id, summary_text, created_at) VALUES (?, ?, ?)");
	stmt.run(meetingId, summaryText, Date.now());
	console.log(`[DB] Saved summary for meeting ${meetingId}`);
}

// Transcription control functions
export function startTranscription(roomId: string): { meetingId: number } | null {
	let room = rooms.get(roomId);
	if (!room) {
		room = {
			id: roomId,
			transcriptionActive: false,
			audioBuffer: [],
			lastProcessedTime: Date.now(),
			lastSpeechTime: 0,
			hasSpeech: false
		};
		rooms.set(roomId, room);
	}
	
	if (!room.transcriptionActive) {
		room.transcriptionActive = true;
		room.meetingId = createMeeting(roomId);
		room.audioBuffer = [];
		room.lastProcessedTime = Date.now();
		room.lastSpeechTime = 0;
		room.hasSpeech = false;
		return { meetingId: room.meetingId };
	}
	
	return null;
}

export async function stopTranscription(roomId: string, participantCount: number): Promise<{ stopped: boolean; summary?: string }> {
	const room = rooms.get(roomId);
	if (room && room.transcriptionActive && room.meetingId) {
		const meetingId = room.meetingId;
		room.transcriptionActive = false;
		endMeeting(meetingId, participantCount);
		
		// Generate summary
		const summary = await generateMeetingSummary(meetingId);
		
		return { stopped: true, summary };
	}
	return { stopped: false };
}

export async function handleRoomEmpty(roomId: string): Promise<void> {
	const room = rooms.get(roomId);
	if (room && room.transcriptionActive && room.meetingId) {
		console.log(`[Transcription] Room ${roomId} empty, ending meeting`);
		const meetingId = room.meetingId;
		endMeeting(meetingId, 1);
		room.transcriptionActive = false;
		
		// Generate summary
		await generateMeetingSummary(meetingId);
	}
}
