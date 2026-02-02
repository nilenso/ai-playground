import type { ServerWebSocket } from "bun";
import { sessions, sessionTimestamps } from "./api/index.ts";

interface WebSocketData {
	sessionId: string | null;
}

type WSMessage =
	| { type: "ask"; requestId: string; sessionId: string; question: string }
	| { type: "ping" }
	| { type: "cancel"; requestId: string }
	| { type: "feedback"; sessionId: string; askIndex: number; feedback: "like" | "dislike" | null };

// Track in-flight requests for cancellation
const activeRequests = new Map<string, AbortController>();

export const websocketHandler = {
	open(_ws: ServerWebSocket<WebSocketData>) {},

	async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
		try {
			const data: WSMessage = JSON.parse(message.toString());

			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
				return;
			}

			if (data.type === "cancel") {
				const controller = activeRequests.get(data.requestId);
				if (controller) {
					controller.abort();
					activeRequests.delete(data.requestId);
					ws.send(JSON.stringify({ type: "cancelled", requestId: data.requestId }));
				}
				return;
			}

			if (data.type === "feedback") {
				const session = sessions.get(data.sessionId) as {
					setFeedback?: (f: "like" | "dislike" | undefined, i?: number) => void;
				};
				session?.setFeedback?.(data.feedback ?? undefined, data.askIndex);
				return;
			}

			if (data.type === "ask") {
				await handleAsk(ws, data.requestId, data.sessionId, data.question);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Unknown error";
			ws.send(JSON.stringify({ type: "error", error: errorMessage }));
		}
	},

	close(_ws: ServerWebSocket<WebSocketData>, _code: number, _reason: string) {},
};

async function handleAsk(ws: ServerWebSocket<WebSocketData>, requestId: string, sessionId: string, question: string) {
	if (!requestId || !sessionId || !question) {
		ws.send(
			JSON.stringify({
				type: "error",
				requestId,
				error: "requestId, sessionId, and question are required",
			}),
		);
		return;
	}

	// Check for duplicate request (idempotency)
	if (activeRequests.has(requestId)) {
		ws.send(
			JSON.stringify({
				type: "error",
				requestId,
				error: "Request already in progress",
			}),
		);
		return;
	}

	const session = sessions.get(sessionId);
	if (!session) {
		ws.send(
			JSON.stringify({
				type: "error",
				requestId,
				error: "Session not found or expired",
			}),
		);
		return;
	}

	// Create abort controller for this request
	const abortController = new AbortController();
	activeRequests.set(requestId, abortController);

	// Update session timestamp
	sessionTimestamps.set(sessionId, Date.now());

	// Send initial thinking state with requestId
	ws.send(JSON.stringify({ type: "progress", requestId, data: { type: "thinking" } }));

	try {
		const result = await session.ask(question, {
			onProgress: (event) => {
				// Check if cancelled
				if (abortController.signal.aborted) return;
				ws.send(JSON.stringify({ type: "progress", requestId, data: event }));
			},
		});

		// Check if cancelled before sending result
		if (abortController.signal.aborted) return;

		ws.send(
			JSON.stringify({
				type: "done",
				requestId,
				data: {
					success: true,
					response: result.response,
					toolCalls: result.toolCalls,
				},
			}),
		);
	} catch (err) {
		if (abortController.signal.aborted) return;
		const errorMessage = err instanceof Error ? err.message : "Unknown error";
		ws.send(JSON.stringify({ type: "error", requestId, error: errorMessage }));
	} finally {
		activeRequests.delete(requestId);
	}
}
