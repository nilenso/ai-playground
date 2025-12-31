import {
	formatTranscriptsForContext,
	getAllTranscripts,
	getTranscriptsBySpeaker,
	getTranscriptsSince,
	type TranscriptEntry,
} from "./db";

const GEMINI_KEY = process.env.GEMINI_KEY || "";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

if (!GEMINI_KEY) {
	console.warn("Warning: GEMINI_KEY not set. Lenso AI features will not work.");
}

interface GeminiResponse {
	candidates?: Array<{
		content: {
			parts: Array<{ text: string }>;
		};
	}>;
	error?: {
		message: string;
	};
}

// Query Gemini with context
async function queryGemini(systemPrompt: string, userQuery: string, context: string): Promise<string> {
	const fullPrompt = `${systemPrompt}

Meeting Transcript:
${context}

User Question: ${userQuery}`;

	const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_KEY}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			contents: [
				{
					parts: [{ text: fullPrompt }],
				},
			],
			generationConfig: {
				temperature: 0.7,
				maxOutputTokens: 1024,
			},
		}),
	});

	const data = (await response.json()) as GeminiResponse;

	if (data.error) {
		throw new Error(data.error.message);
	}

	if (!data.candidates || data.candidates.length === 0) {
		throw new Error("No response from Gemini");
	}

	return data.candidates[0].content.parts[0].text;
}

// System prompt for the meeting assistant
const MEETING_ASSISTANT_PROMPT = `You are Lenso, an AI meeting assistant. You help participants understand and recall what was discussed in the meeting.

Guidelines:
- Be concise and helpful
- Reference specific speakers and times when relevant
- If asked about something not in the transcript, say you don't have that information
- Format your responses clearly
- When listing action items, use bullet points
- When summarizing, focus on key decisions and discussions`;

// Parse user query to determine intent and extract parameters
interface ParsedQuery {
	type: "speaker_query" | "time_query" | "summary" | "action_items" | "general";
	speakerName?: string;
	timeMinutes?: number;
}

function parseQuery(query: string): ParsedQuery {
	const lowerQuery = query.toLowerCase();

	// Check for action items query
	if (
		lowerQuery.includes("action item") ||
		lowerQuery.includes("todo") ||
		lowerQuery.includes("to do") ||
		lowerQuery.includes("tasks")
	) {
		return { type: "action_items" };
	}

	// Check for summary query
	if (lowerQuery.includes("summarize") || lowerQuery.includes("summary") || lowerQuery.includes("summarise")) {
		if (lowerQuery.includes("whole") || lowerQuery.includes("entire") || lowerQuery.includes("full")) {
			return { type: "summary" };
		}
		// Check for time-based summary
		const timeMatch = lowerQuery.match(/last\s+(\d+)\s+minutes?/);
		if (timeMatch) {
			return { type: "time_query", timeMinutes: parseInt(timeMatch[1]) };
		}
		return { type: "summary" };
	}

	// Check for time-based query (e.g., "last 15 minutes")
	const timeMatch = lowerQuery.match(/last\s+(\d+)\s+minutes?/);
	if (timeMatch) {
		return { type: "time_query", timeMinutes: parseInt(timeMatch[1]) };
	}

	// Check for speaker-specific query (e.g., "What did John say about...")
	const speakerMatch = lowerQuery.match(/what\s+did\s+(\w+)\s+say/i);
	if (speakerMatch) {
		return { type: "speaker_query", speakerName: speakerMatch[1] };
	}

	// Also check for "[Name] said" or "according to [Name]"
	const speakerMatch2 = lowerQuery.match(/(\w+)\s+said|according\s+to\s+(\w+)/i);
	if (speakerMatch2) {
		return { type: "speaker_query", speakerName: speakerMatch2[1] || speakerMatch2[2] };
	}

	return { type: "general" };
}

// Main function to handle Lenso queries
export async function handleLensoQuery(roomId: string, query: string): Promise<string> {
	if (!GEMINI_KEY) {
		return "Lenso AI is not configured. Please set the GEMINI_KEY environment variable.";
	}

	const parsed = parseQuery(query);
	let transcripts: TranscriptEntry[];
	let context: string;

	switch (parsed.type) {
		case "speaker_query":
			if (parsed.speakerName) {
				// Get transcripts from the specific speaker plus some context
				const speakerTranscripts = getTranscriptsBySpeaker(roomId, parsed.speakerName);
				const allTranscripts = getAllTranscripts(roomId);

				if (speakerTranscripts.length === 0) {
					return `I couldn't find any messages from "${parsed.speakerName}" in this meeting. The participants I can see are: ${[...new Set(allTranscripts.map((t) => t.speaker_name))].join(", ")}.`;
				}

				// Use all transcripts for context but the query will focus on the speaker
				transcripts = allTranscripts;
				context = formatTranscriptsForContext(transcripts);
			} else {
				transcripts = getAllTranscripts(roomId);
				context = formatTranscriptsForContext(transcripts);
			}
			break;

		case "time_query":
			if (parsed.timeMinutes) {
				const sinceTimestamp = Date.now() - parsed.timeMinutes * 60 * 1000;
				transcripts = getTranscriptsSince(roomId, sinceTimestamp);

				if (transcripts.length === 0) {
					return `No messages found in the last ${parsed.timeMinutes} minutes.`;
				}

				context = formatTranscriptsForContext(transcripts);
			} else {
				transcripts = getAllTranscripts(roomId);
				context = formatTranscriptsForContext(transcripts);
			}
			break;

		case "summary":
			transcripts = getAllTranscripts(roomId);
			if (transcripts.length === 0) {
				return "There's no transcript to summarize yet. The meeting transcript will be available once participants start speaking.";
			}
			context = formatTranscriptsForContext(transcripts);
			break;

		case "action_items":
			transcripts = getAllTranscripts(roomId);
			if (transcripts.length === 0) {
				return "There's no transcript to extract action items from yet.";
			}
			context = formatTranscriptsForContext(transcripts);
			// Modify the query to be more specific about action items
			query =
				"Please extract and list all action items, tasks, and commitments mentioned in this meeting. Format them as a bullet list with the responsible person if mentioned.";
			break;

		default:
			transcripts = getAllTranscripts(roomId);
			if (transcripts.length === 0) {
				return "The meeting transcript is empty. I'll be able to answer questions once participants start speaking.";
			}
			context = formatTranscriptsForContext(transcripts);
	}

	try {
		const response = await queryGemini(MEETING_ASSISTANT_PROMPT, query, context);
		return response;
	} catch (error) {
		console.error("Gemini API error:", error);
		return `Sorry, I encountered an error processing your question. Please try again. Error: ${error instanceof Error ? error.message : "Unknown error"}`;
	}
}

// Transcription using Gemini (for audio chunks)
export async function transcribeWithGemini(audioBase64: string, mimeType: string): Promise<string> {
	if (!GEMINI_KEY) {
		throw new Error("GEMINI_KEY not configured");
	}

	const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_KEY}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{
							text: "Transcribe this audio. Return only the spoken words, nothing else. If there's no speech or the audio is unclear, return an empty string.",
						},
						{
							inline_data: {
								mime_type: mimeType,
								data: audioBase64,
							},
						},
					],
				},
			],
			generationConfig: {
				temperature: 0.1,
				maxOutputTokens: 256,
			},
		}),
	});

	const data = (await response.json()) as GeminiResponse;

	if (data.error) {
		throw new Error(data.error.message);
	}

	if (!data.candidates || data.candidates.length === 0) {
		return "";
	}

	return data.candidates[0].content.parts[0].text.trim();
}
