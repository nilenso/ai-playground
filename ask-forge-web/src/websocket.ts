import type { ServerWebSocket } from "bun";
import { sessions, sessionTimestamps } from "./api/index.ts";
import { wsLogger } from "./lib/logger.ts";
import { summarizeTurn } from "./lib/session-logger.ts";

interface WebSocketData {
	sessionId: string | null;
}

type WSMessage =
	| { type: "ask"; requestId: string; sessionId: string; question: string }
	| { type: "ping" }
	| { type: "cancel"; requestId: string }
	| { type: "feedback"; sessionId: string; askIndex: number; feedback: "like" | "dislike" | null }
	| { type: "resume"; sessionId: string };

// Track in-flight requests for cancellation
const activeRequests = new Map<string, AbortController>();

// Track requestId -> sessionId mapping for cancellation
const requestToSession = new Map<string, string>();

// Buffer for streaming output per session - allows resuming after page refresh
type WireEvent = {
	type: string;
	requestId: string;
	data?: unknown;
	error?: string;
	errorType?: string;
	retryability?: string;
};
interface StreamBuffer {
	requestId: string;
	sessionId: string;
	question: string;
	events: WireEvent[];
	completed: boolean;
	completedAt?: number;
}
const streamBuffers = new Map<string, StreamBuffer>();

// Clean up completed buffers after 30 seconds
const BUFFER_TTL = 30_000;
setInterval(() => {
	const now = Date.now();
	for (const [sessionId, buffer] of streamBuffers) {
		if (buffer.completed && buffer.completedAt && now - buffer.completedAt > BUFFER_TTL) {
			streamBuffers.delete(sessionId);
		}
	}
}, 10_000);

// Export for API to check active requests
export function getActiveRequest(sessionId: string): { requestId: string; question: string } | null {
	const buffer = streamBuffers.get(sessionId);
	if (buffer && !buffer.completed) {
		return { requestId: buffer.requestId, question: buffer.question };
	}
	return null;
}

// Track WebSocket connections per session for broadcasting
const sessionConnections = new Map<string, Set<ServerWebSocket<WebSocketData>>>();

// Register a WebSocket connection for a session
function registerConnection(ws: ServerWebSocket<WebSocketData>, sessionId: string) {
	ws.data.sessionId = sessionId;
	let connections = sessionConnections.get(sessionId);
	if (!connections) {
		connections = new Set();
		sessionConnections.set(sessionId, connections);
	}
	connections.add(ws);
}

export const websocketHandler = {
	open(_ws: ServerWebSocket<WebSocketData>) {
		wsLogger.debug("WebSocket connection opened");
	},

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

					// Mark the stream buffer as completed to allow new requests
					const sessionId = requestToSession.get(data.requestId);
					if (sessionId) {
						const buffer = streamBuffers.get(sessionId);
						if (buffer) {
							buffer.completed = true;
							buffer.completedAt = Date.now();
						}
						requestToSession.delete(data.requestId);
					}

					ws.send(JSON.stringify({ type: "cancelled", requestId: data.requestId }));
					wsLogger.info("Request cancelled: {requestId} (session={sessionId})", {
						requestId: data.requestId,
						sessionId: sessionId ?? "unknown",
					});
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

			if (data.type === "resume") {
				// Client is resuming after a page refresh - replay buffered events
				const buffer = streamBuffers.get(data.sessionId);
				if (buffer) {
					registerConnection(ws, data.sessionId);

					// Send resume acknowledgment with the question
					ws.send(
						JSON.stringify({
							type: "resume_start",
							requestId: buffer.requestId,
							question: buffer.question,
							completed: buffer.completed,
						}),
					);

					// Replay all buffered events
					for (const event of buffer.events) {
						ws.send(JSON.stringify(event));
					}

					// Signal end of buffer replay
					// If completed, send resume_complete so client finalizes
					// If still streaming, send resume_caught_up so client knows to process new events normally
					if (buffer.completed) {
						ws.send(JSON.stringify({ type: "resume_complete", requestId: buffer.requestId }));
					} else {
						ws.send(JSON.stringify({ type: "resume_caught_up", requestId: buffer.requestId }));
					}

					wsLogger.info("Session resumed: {sessionId}, buffered={eventCount} events, completed={completed}", {
						sessionId: data.sessionId,
						eventCount: buffer.events.length,
						completed: buffer.completed,
					});
				} else {
					// No active or buffered request for this session
					ws.send(JSON.stringify({ type: "resume_none", sessionId: data.sessionId }));
					wsLogger.debug("Resume requested but no buffer for session {sessionId}", {
						sessionId: data.sessionId,
					});
				}
				return;
			}

			if (data.type === "ask") {
				registerConnection(ws, data.sessionId);
				await handleAsk(ws, data.requestId, data.sessionId, data.question);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Unknown error";
			ws.send(JSON.stringify({ type: "error", error: errorMessage }));
			wsLogger.error("WebSocket message handling error: {error}", { error: errorMessage });
		}
	},

	close(ws: ServerWebSocket<WebSocketData>, code: number, _reason: string) {
		// Remove from session connections
		if (ws.data.sessionId) {
			const connections = sessionConnections.get(ws.data.sessionId);
			if (connections) {
				connections.delete(ws);
				if (connections.size === 0) {
					sessionConnections.delete(ws.data.sessionId);
				}
			}
			wsLogger.debug("WebSocket closed for session {sessionId} (code={code})", {
				sessionId: ws.data.sessionId,
				code,
			});
		}
	},
};

// Broadcast to all connections for a session and buffer the event
function broadcastAndBuffer(sessionId: string, event: WireEvent) {
	// Buffer the event
	const buffer = streamBuffers.get(sessionId);
	if (buffer && !buffer.completed) {
		buffer.events.push(event);
	}

	// Broadcast to all connections
	const connections = sessionConnections.get(sessionId);
	if (connections) {
		const message = JSON.stringify(event);
		for (const conn of connections) {
			try {
				conn.send(message);
			} catch (err) {
				wsLogger.debug("Failed to send to WebSocket (connection closed): {error}", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}

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
		wsLogger.warn("Duplicate request rejected: {requestId}", { requestId, sessionId });
		return;
	}

	// Check if there's already an active request for this session
	const existingBuffer = streamBuffers.get(sessionId);
	if (existingBuffer && !existingBuffer.completed) {
		ws.send(
			JSON.stringify({
				type: "error",
				requestId,
				error: "Another request is already in progress for this session",
			}),
		);
		wsLogger.warn("Concurrent request rejected for session {sessionId} (existing={existingRequestId})", {
			sessionId,
			requestId,
			existingRequestId: existingBuffer.requestId,
		});
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
		wsLogger.warn("Ask for expired/missing session {sessionId}", { sessionId, requestId });
		return;
	}

	// /compact was a force-compact slash command. Phase 5 dropped it: the new
	// library handles compaction automatically and offers no public force API.
	// Reject any /compact attempts so users get a clear error instead of silently
	// asking the model to do something with literal "/compact" as the prompt.
	if (question.startsWith("/compact")) {
		ws.send(
			JSON.stringify({
				type: "error",
				requestId,
				error: "/compact is no longer supported — compaction now runs automatically when context fills.",
			}),
		);
		return;
	}

	// Create abort controller for this request
	const abortController = new AbortController();
	activeRequests.set(requestId, abortController);

	// Track requestId -> sessionId mapping
	requestToSession.set(requestId, sessionId);

	// Initialize stream buffer for this session
	streamBuffers.set(sessionId, {
		requestId,
		sessionId,
		question,
		events: [],
		completed: false,
	});

	// Update session timestamp
	sessionTimestamps.set(sessionId, Date.now());

	// Send initial thinking state so the UI sees activity before the first stream event arrives
	broadcastAndBuffer(sessionId, { type: "progress", requestId, data: { type: "thinking" } });

	const askStart = Date.now();
	wsLogger.info("Ask started: session={sessionId}, request={requestId}, question={questionPreview}", {
		sessionId,
		requestId,
		questionPreview: question.length > 120 ? `${question.slice(0, 117)}...` : question,
	});

	const finishBuffer = () => {
		const buffer = streamBuffers.get(sessionId);
		if (buffer) {
			buffer.completed = true;
			buffer.completedAt = Date.now();
		}
	};

	const askStream = session.ask(question, { signal: abortController.signal });
	let toolCallCount = 0;
	let responseLength = 0;
	try {
		for await (const event of askStream) {
			if (event.type === "tool_use_end") toolCallCount++;
			if (event.type === "text") responseLength += event.text.length;
			if (event.type === "error") {
				// Don't double-up on cancel: the cancel handler already sent {type: 'cancelled'}.
				if (event.errorType === "aborted" && abortController.signal.aborted) continue;
				broadcastAndBuffer(sessionId, {
					type: "error",
					requestId,
					error: event.message,
					errorType: event.errorType,
					retryability: event.retryability,
				});
				continue;
			}
			broadcastAndBuffer(sessionId, { type: "progress", requestId, data: event });
		}

		const turn = await askStream.result();

		if (turn.error) {
			finishBuffer();
			if (turn.error.errorType === "aborted" && abortController.signal.aborted) {
				wsLogger.info("Ask cancelled: session={sessionId}, request={requestId} ({durationMs}ms)", {
					sessionId,
					requestId,
					durationMs: Date.now() - askStart,
				});
				return;
			}
			// Terminal error event was already forwarded inside the loop.
			wsLogger.warn(
				"Ask ended with error: session={sessionId}, request={requestId}, errorType={errorType} ({durationMs}ms)",
				{
					sessionId,
					requestId,
					errorType: turn.error.errorType,
					durationMs: Date.now() - askStart,
				},
			);
			return;
		}

		const { response, toolCalls } = summarizeTurn(turn);
		broadcastAndBuffer(sessionId, {
			type: "done",
			requestId,
			data: { success: true, response, toolCalls },
		});
		finishBuffer();

		wsLogger.info(
			"Ask completed: session={sessionId}, request={requestId}, toolCalls={toolCallCount}, {durationMs}ms",
			{
				sessionId,
				requestId,
				toolCallCount,
				responseLength,
				durationMs: Date.now() - askStart,
			},
		);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : "Unknown error";
		broadcastAndBuffer(sessionId, { type: "error", requestId, error: errorMessage });
		finishBuffer();
		wsLogger.error("Ask failed: session={sessionId}, request={requestId}, error={error} ({durationMs}ms)", {
			sessionId,
			requestId,
			error: errorMessage,
			durationMs: Date.now() - askStart,
		});
	} finally {
		activeRequests.delete(requestId);
		requestToSession.delete(requestId);
	}
}
