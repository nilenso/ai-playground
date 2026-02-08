import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { DbMessage } from "./lib/db.ts";
import { getAnnotationsBySession, getDb, upsertAnnotation } from "./lib/db.ts";

const app = new Hono();

interface SessionRow {
	id: string;
	title: string | null;
	status: string;
	created_at: string;
	ended_at: string | null;
	git_url: string;
	repository_name: string;
	username_or_organization: string;
	ask_count: number;
}

// API to list available sessions from DB
app.get("/api/sessions", (c) => {
	try {
		const db = getDb();
		const sessions = db
			.query<SessionRow, []>(
				`SELECT s.id, s.title, s.status, s.created_at, s.ended_at,
				        r.git_url, r.repository_name, r.username_or_organization,
				        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS ask_count
				 FROM sessions s
				 JOIN repositories r ON s.repository_id = r.id
				 ORDER BY s.created_at DESC`,
			)
			.all();

		const result = sessions.map((s) => ({
			id: s.id,
			repo: s.git_url,
			startedAt: new Date(s.created_at).getTime(),
			endReason: s.status,
			askCount: s.ask_count,
			firstQuestion: s.title || "",
		}));

		return c.json({ success: true, sessions: result });
	} catch (err) {
		return c.json(
			{
				success: false,
				error: err instanceof Error ? err.message : "Failed to list sessions",
			},
			500,
		);
	}
});

// API to load a specific session by ID
app.get("/api/session/:id", (c) => {
	const id = c.req.param("id");

	try {
		const db = getDb();

		// Get session + repository info
		const session = db
			.query<
				{
					id: string;
					title: string | null;
					status: string;
					created_at: string;
					ended_at: string | null;
					git_url: string;
					default_commit: string;
					system_prompt: string | null;
				},
				[string]
			>(
				`SELECT s.id, s.title, s.status, s.created_at, s.ended_at,
				        s.system_prompt, r.git_url, r.default_commit
				 FROM sessions s
				 JOIN repositories r ON s.repository_id = r.id
				 WHERE s.id = ?`,
			)
			.get(id);

		if (!session) {
			return c.json({ success: false, error: "Session not found" }, 404);
		}

		// Get messages ordered by ordinal
		const messages = db
			.query<DbMessage, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal")
			.all(id);

		// Get usage stats keyed by message_id
		const usageRows = db
			.query<
				{
					message_id: number;
					input_tokens: number;
					output_tokens: number;
					total_tokens: number;
					cache_read_tokens: number;
					cache_write_tokens: number;
					inference_time_ms: number;
				},
				[string]
			>("SELECT * FROM usage_stats WHERE session_id = ?")
			.all(id);

		const usageByMessageId = new Map(usageRows.map((u) => [u.message_id, u]));

		// Get feedback keyed by message_id
		const feedbackRows = db
			.query<{ message_id: number; feedback: string }, [string]>(
				`SELECT mf.message_id, mf.feedback
				 FROM message_feedback mf
				 JOIN messages m ON mf.message_id = m.id
				 WHERE m.session_id = ?`,
			)
			.all(id);

		const feedbackByMessageId = new Map(feedbackRows.map((f) => [f.message_id, f.feedback]));

		// Get annotations for this session
		const annotationsByAskIndex = getAnnotationsBySession(id);

		// Reconstruct asks[] by pairing user messages with subsequent assistant messages
		const asks: Array<{
			timestamp: number;
			question: string;
			toolCalls: Array<{
				type: string;
				id: string;
				name: string;
				arguments: Record<string, unknown>;
				result?: string;
			}>;
			response: string;
			usage?: {
				input: number;
				output: number;
				totalTokens: number;
				cacheRead: number;
				cacheWrite: number;
			};
			inferenceTimeMs?: number;
			feedback?: string;
			annotation?: {
				isRelevant: boolean | null;
				isEvidenceSupported: boolean | null;
				isClear: boolean | null;
				feedbackText: string | null;
			};
		}> = [];

		let currentAsk: (typeof asks)[0] | null = null;
		// Track which tool calls need results (by index in currentAsk.toolCalls)
		let pendingToolCalls: Array<{ name: string; index: number }> = [];

		for (const msg of messages) {
			if (msg.role === "user") {
				// Start a new ask entry
				if (currentAsk) {
					asks.push(currentAsk);
				}
				currentAsk = {
					timestamp: new Date(msg.created_at).getTime(),
					question: msg.content || "",
					toolCalls: [],
					response: "",
				};
				pendingToolCalls = [];
			} else if (msg.role === "assistant" && currentAsk) {
				// Parse content JSON array to extract tool calls and text
				if (msg.content) {
					try {
						const contentParts = JSON.parse(msg.content);
						if (Array.isArray(contentParts)) {
							for (const part of contentParts) {
								if (part.type === "toolCall") {
									const index = currentAsk.toolCalls.length;
									currentAsk.toolCalls.push({
										type: part.type,
										id: part.id || "",
										name: part.name || "",
										arguments: part.arguments || {},
									});
									// Queue this tool call to receive a result
									pendingToolCalls.push({ name: part.name || "", index });
								} else if (part.type === "text" && part.text) {
									currentAsk.response += (currentAsk.response ? "\n" : "") + part.text;
								}
							}
						} else {
							// Plain string content
							currentAsk.response += (currentAsk.response ? "\n" : "") + msg.content;
						}
					} catch {
						// Not JSON, treat as plain text
						currentAsk.response += (currentAsk.response ? "\n" : "") + msg.content;
					}
				}
				// Attach usage stats if available
				const usage = usageByMessageId.get(msg.id);
				if (usage) {
					currentAsk.usage = {
						input: usage.input_tokens,
						output: usage.output_tokens,
						totalTokens: usage.total_tokens,
						cacheRead: usage.cache_read_tokens,
						cacheWrite: usage.cache_write_tokens,
					};
					currentAsk.inferenceTimeMs = usage.inference_time_ms;
				}

				// Attach feedback if available
				const feedback = feedbackByMessageId.get(msg.id);
				if (feedback) {
					currentAsk.feedback = feedback;
				}
			} else if (msg.role === "tool" && currentAsk) {
				// Match tool result to the first pending tool call with matching name
				const toolName = msg.tool_name || "";
				const pendingIndex = pendingToolCalls.findIndex((p) => p.name === toolName);
				if (pendingIndex !== -1) {
					const { index } = pendingToolCalls[pendingIndex];
					currentAsk.toolCalls[index].result = msg.content || msg.tool_result || "";
					// Remove from pending
					pendingToolCalls.splice(pendingIndex, 1);
				}
			}
		}

		// Don't forget the last ask
		if (currentAsk) {
			asks.push(currentAsk);
		}

		// Attach annotations to asks (normalize SQLite 1/0 to boolean)
		const toBool = (v: number | boolean | null): boolean | null => (v === null ? null : v === 1 || v === true);
		for (let i = 0; i < asks.length; i++) {
			const annotation = annotationsByAskIndex.get(i);
			if (annotation) {
				asks[i].annotation = {
					isRelevant: toBool(annotation.is_relevant),
					isEvidenceSupported: toBool(annotation.is_evidence_supported),
					isClear: toBool(annotation.is_clear),
					feedbackText: annotation.feedback_text,
				};
			}
		}

		const sessionLog = {
			sessionId: session.id,
			repo: { url: session.git_url, commitish: session.default_commit },
			startedAt: new Date(session.created_at).getTime(),
			endedAt: session.ended_at ? new Date(session.ended_at).getTime() : Date.now(),
			endReason: session.status,
			systemPrompt: session.system_prompt ?? null,
			asks,
		};

		return c.json({ success: true, session: sessionLog });
	} catch (err) {
		return c.json(
			{
				success: false,
				error: err instanceof Error ? err.message : "Failed to load session",
			},
			500,
		);
	}
});

// API to export session as pi-agent JSONL format
app.get("/api/session/:id/export", (c) => {
	const id = c.req.param("id");

	try {
		const db = getDb();

		// Get session + repository info
		const session = db
			.query<
				{
					id: string;
					created_at: string;
					git_url: string;
				},
				[string]
			>(
				`SELECT s.id, s.created_at, r.git_url
				 FROM sessions s
				 JOIN repositories r ON s.repository_id = r.id
				 WHERE s.id = ?`,
			)
			.get(id);

		if (!session) {
			return c.json({ success: false, error: "Session not found" }, 404);
		}

		// Get messages ordered by ordinal
		const messages = db
			.query<DbMessage, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal")
			.all(id);

		// Build JSONL lines in pi-agent format
		const lines: string[] = [];

		// Session header
		lines.push(
			JSON.stringify({
				type: "session",
				version: 3,
				id: session.id,
				timestamp: new Date(session.created_at).toISOString(),
				cwd: session.git_url,
			}),
		);

		// Generate short IDs for messages
		const generateId = () => Math.random().toString(16).slice(2, 10);
		let parentId: string | null = null;

		for (const msg of messages) {
			const msgId = generateId();

			if (msg.role === "user") {
				lines.push(
					JSON.stringify({
						type: "message",
						id: msgId,
						parentId,
						timestamp: new Date(msg.created_at).toISOString(),
						message: {
							role: "user",
							content: [{ type: "text", text: msg.content || "" }],
							timestamp: new Date(msg.created_at).getTime(),
						},
					}),
				);
				parentId = msgId;
			} else if (msg.role === "assistant") {
				// Parse content JSON to get tool calls and text
				let content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }> = [];
				if (msg.content) {
					try {
						const parsed = JSON.parse(msg.content);
						if (Array.isArray(parsed)) {
							content = parsed;
						} else {
							content = [{ type: "text", text: msg.content }];
						}
					} catch {
						content = [{ type: "text", text: msg.content }];
					}
				}

				lines.push(
					JSON.stringify({
						type: "message",
						id: msgId,
						parentId,
						timestamp: new Date(msg.created_at).toISOString(),
						message: {
							role: "assistant",
							content,
							timestamp: new Date(msg.created_at).getTime(),
						},
					}),
				);
				parentId = msgId;
			} else if (msg.role === "tool") {
				lines.push(
					JSON.stringify({
						type: "message",
						id: msgId,
						parentId,
						timestamp: new Date(msg.created_at).toISOString(),
						message: {
							role: "toolResult",
							toolCallId: msg.tool_arguments || "",
							toolName: msg.tool_name || "",
							content: [{ type: "text", text: msg.content || msg.tool_result || "" }],
							isError: false,
							timestamp: new Date(msg.created_at).getTime(),
						},
					}),
				);
				parentId = msgId;
			}
		}

		// Return as JSONL file download
		const filename = `session-${session.id}.jsonl`;
		const body = lines.join("\n") + "\n";
		return new Response(body, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Content-Disposition": `attachment; filename="${filename}"`,
			},
		});
	} catch (err) {
		return c.json(
			{
				success: false,
				error: err instanceof Error ? err.message : "Failed to export session",
			},
			500,
		);
	}
});

// API to upsert an annotation for a specific response
app.put("/api/session/:id/annotation/:askIndex", async (c) => {
	const sessionId = c.req.param("id");
	const askIndex = Number.parseInt(c.req.param("askIndex"), 10);

	if (Number.isNaN(askIndex) || askIndex < 0) {
		return c.json({ success: false, error: "Invalid askIndex" }, 400);
	}

	try {
		const body = await c.req.json();
		const { isRelevant, isEvidenceSupported, isClear, feedbackText } = body;

		const annotation = upsertAnnotation({
			sessionId,
			askIndex,
			isRelevant: isRelevant ?? null,
			isEvidenceSupported: isEvidenceSupported ?? null,
			isClear: isClear ?? null,
			feedbackText: feedbackText ?? null,
		});

		// Normalize SQLite 1/0 to boolean
		const toBool = (v: number | boolean | null): boolean | null => (v === null ? null : v === 1 || v === true);

		return c.json({
			success: true,
			annotation: {
				isRelevant: toBool(annotation.is_relevant),
				isEvidenceSupported: toBool(annotation.is_evidence_supported),
				isClear: toBool(annotation.is_clear),
				feedbackText: annotation.feedback_text,
			},
		});
	} catch (err) {
		return c.json(
			{
				success: false,
				error: err instanceof Error ? err.message : "Failed to save annotation",
			},
			500,
		);
	}
});

// Serve visualizer.html for root
app.get("/", async (c) => {
	const html = await Bun.file("./public/visualizer.html").text();
	return c.html(html);
});

// Serve static files from public directory
app.use("/*", serveStatic({ root: "./public" }));

const port = process.env.PORT || 3001;

console.log(`📊 Visualizer running at http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch,
};
