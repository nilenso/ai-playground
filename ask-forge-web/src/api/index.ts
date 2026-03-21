import { AskForgeClient, type Session } from "@nilenso/ask-forge";
import { Hono } from "hono";

// The SYSTEM_PROMPT is not re-exported from @nilenso/ask-forge's package index,
// so we read it from the config module at the resolved path.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of internal module
const askForgeConfig: any = await import(import.meta.resolve("@nilenso/ask-forge").replace("/index.js", "/config.js"));
const SYSTEM_PROMPT: string = askForgeConfig.SYSTEM_PROMPT;

// Initialize ask-forge client with sandbox configuration if available
const sandboxUrl = process.env.SANDBOX_URL;
const sandboxSecret = process.env.SANDBOX_SECRET;

const askForgeClient = new AskForgeClient(
	sandboxUrl
		? {
				sandbox: {
					baseUrl: sandboxUrl,
					secret: sandboxSecret,
					timeoutMs: 120000, // 2 minutes for git clone operations
				},
			}
		: undefined,
);

sandboxLogger.info("Sandbox mode: {mode}", {
	mode: sandboxUrl ? "enabled" : "disabled",
	sandboxUrl: sandboxUrl ?? null,
});

import { createAuthMiddleware, getUserFromContext } from "../lib/auth.ts";
import {
	createSession as createDbSession,
	createMessage,
	createShareLink,
	deleteSession,
	deleteShareLink,
	findOrCreateRepository,
	getDb,
	getLatestCompaction,
	getMessagesBySession,
	getNonCompactedMessages,
	getRepositoryByGitUrl,
	getSession,
	getShareLink,
	recordCheckout,
	updateSessionStatus,
	updateSessionTitle,
} from "../lib/db.ts";
import { sandboxLogger, sessionLogger, startupLogger } from "../lib/logger.ts";
import { normalizeGitUrl } from "../lib/normalize-url.ts";
import { buildSessionContext } from "../lib/session-context.ts";
import { wrapSession } from "../lib/session-logger.ts";
import { getActiveRequest } from "../websocket.ts";

// Git environment to prevent interactive prompts and SSH key loading
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "",
};

// In-memory session store (exported for WebSocket handler)
export const sessions = new Map<string, Session>();

// Clean up sessions idle for more than 10 minutes (no connect/restore/ask activity)
const SESSION_TTL = 10 * 60 * 1000;
export const sessionTimestamps = new Map<string, number>();

function cleanupSessions() {
	const now = Date.now();
	for (const [id, timestamp] of sessionTimestamps) {
		if (now - timestamp > SESSION_TTL) {
			const session = sessions.get(id);
			if (session) {
				try {
					session.close();
				} catch (err) {
					sessionLogger.error("Failed to close expired session {sessionId}: {error}", {
						sessionId: id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				sessions.delete(id);
			}
			sessionTimestamps.delete(id);
			updateSessionStatus(id, "inactive");
			sessionLogger.info("Cleaned up expired session {sessionId} (idle {idleMinutes}m)", {
				sessionId: id,
				idleMinutes: Math.round((now - timestamp) / 60_000),
			});
		}
	}
}

// Run cleanup every 5 minutes
setInterval(cleanupSessions, 5 * 60 * 1000);

// On startup, mark all "active" sessions as "inactive" since in-memory state is lost on restart
(function cleanupStaleActiveSessions() {
	const db = getDb();
	const result = db.run("UPDATE sessions SET status = 'inactive', ended_at = ? WHERE status = 'active'", [
		new Date().toISOString(),
	]);
	if (result.changes > 0) {
		startupLogger.info("Marked {count} stale active session(s) as inactive on startup", {
			count: result.changes,
		});
	}
})();

const api = new Hono();

api.get("/health", (c) => {
	return c.json({ status: "ok" });
});

/**
 * Validate a git URL by checking if it's cloneable
 */
api.post("/validate", createAuthMiddleware(), async (c) => {
	const body = await c.req.json<{ url: string }>();
	const { url } = body;

	if (!url) {
		return c.json({ valid: false, error: "URL is required" }, 400);
	}

	const { normalized, error } = normalizeGitUrl(url);

	if (!normalized) {
		return c.json({ valid: false, error }, 400);
	}

	const proc = Bun.spawn(["git", "ls-remote", "--heads", normalized], {
		stdout: "pipe",
		stderr: "pipe",
		env: GIT_ENV,
	});

	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		return c.json({
			valid: false,
			normalized,
			error: stderr.trim() || "Repository not accessible",
		});
	}

	return c.json({ valid: true, normalized });
});

/**
 * Connect to a repository and create a session.
 * Streams progress via SSE so long clones don't hit proxy timeouts (Cloudflare 100s).
 *
 * Events:
 *   event: progress  — { message: "Cloning repository… 45s" }
 *   event: done      — full connect result JSON
 *   event: error     — { success: false, error: "..." }
 */
api.post("/connect", createAuthMiddleware(), async (c) => {
	const payload = getUserFromContext(c);
	if (!payload) return c.json({ success: false, error: "Unauthorized" }, 401);

	const body = await c.req.json<{ url: string; commit?: string }>();
	const { url, commit } = body;

	if (!url) {
		return c.json({ success: false, error: "URL is required" }, 400);
	}

	const { normalized, error } = normalizeGitUrl(url);

	if (!normalized) {
		return c.json({ success: false, error }, 400);
	}

	const sseStream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			// Heartbeat keeps Cloudflare/Caddy from timing out
			const heartbeat = setInterval(() => {
				send("heartbeat", { ts: Date.now() });
			}, 15000);

			const connectStart = Date.now();
			try {
				const rawSession = await askForgeClient.connect(normalized, { commitish: commit }, (message) => {
					send("progress", { message });
				});

				// Check for cached summary
				const existingRepo = getRepositoryByGitUrl(normalized);
				const summary: string | null = existingRepo?.summary || null;

				// Save/update repository record
				const repository = findOrCreateRepository({
					userInputUrl: url,
					gitUrl: normalized,
					defaultCommit: rawSession.repo.commitish,
				});

				// Record this checkout
				const checkout = recordCheckout({
					repositoryId: repository.id,
					commitId: rawSession.repo.commitish,
				});

				// Create a DB session record so messages get persisted
				createDbSession({
					id: rawSession.id,
					userId: payload.sub,
					repositoryId: repository.id,
					checkoutId: checkout.id,
					systemPrompt: SYSTEM_PROMPT,
				});

				const session = wrapSession(rawSession, rawSession.id);

				// Store the session
				sessions.set(session.id, session);
				sessionTimestamps.set(session.id, Date.now());

				sessionLogger.info("Session connected: {sessionId} to {repoUrl} @ {commit} (user={userId}, {durationMs}ms)", {
					sessionId: session.id,
					repoUrl: normalized,
					commit: session.repo.commitish,
					userId: payload.sub,
					durationMs: Date.now() - connectStart,
				});

				send("done", {
					success: true,
					sessionId: session.id,
					normalized,
					localPath: session.repo.localPath,
					commitish: session.repo.commitish,
					summary,
					repositoryId: repository.id,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				sessionLogger.error("Session connect failed for {repoUrl}: {error} (user={userId}, {durationMs}ms)", {
					repoUrl: normalized,
					error: message,
					userId: payload.sub,
					durationMs: Date.now() - connectStart,
				});
				send("error", { success: false, error: message });
			} finally {
				clearInterval(heartbeat);
				closed = true;
				controller.close();
			}
		},
	});

	return new Response(sseStream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

/**
 * Ask a question in an existing session (streaming progress via SSE)
 */
api.post("/ask", createAuthMiddleware(), async (c) => {
	const body = await c.req.json<{ sessionId: string; question: string }>();
	const { sessionId, question } = body;

	if (!sessionId || !question) {
		return c.json({ success: false, error: "sessionId and question are required" }, 400);
	}

	const session = sessions.get(sessionId);
	if (!session) {
		return c.json({ success: false, error: "Session not found or expired" }, 404);
	}

	// Update session timestamp
	sessionTimestamps.set(sessionId, Date.now());

	// Stream progress events via SSE
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			// Send immediate thinking event to keep connection alive
			send("progress", { type: "thinking" });

			// Heartbeat to prevent timeout during long LLM calls
			const heartbeat = setInterval(() => {
				send("heartbeat", { ts: Date.now() });
			}, 15000);

			try {
				const result = await session.ask(question, {
					onProgress: (event) => {
						send("progress", event);
					},
				});

				send("done", {
					success: true,
					response: result.response,
					toolCalls: result.toolCalls,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				send("error", { success: false, error: message });
			} finally {
				clearInterval(heartbeat);
				closed = true;
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

/**
 * Restore a previous session from the database
 */
api.post("/restore", createAuthMiddleware(), async (c) => {
	const body = await c.req.json<{ sessionId: string }>();
	const { sessionId } = body;

	if (!sessionId) {
		return c.json({ success: false, error: "sessionId is required" }, 400);
	}

	// Check if session is already in memory (e.g., switching tabs or resuming)
	const existingSession = sessions.get(sessionId);
	if (existingSession) {
		// Session already active - just update timestamp and return
		sessionTimestamps.set(sessionId, Date.now());

		const db = getDb();
		const repoRow = db
			.query<{ git_url: string; summary: string | null; id: number }, [string]>(
				"SELECT r.id, r.git_url, r.summary FROM repositories r JOIN sessions s ON s.repository_id = r.id WHERE s.id = ?",
			)
			.get(sessionId);

		const activeReq = getActiveRequest(sessionId);

		return c.json({
			success: true,
			sessionId: existingSession.id,
			normalized: repoRow?.git_url,
			localPath: existingSession.repo.localPath,
			commitish: existingSession.repo.commitish,
			summary: repoRow?.summary,
			repositoryId: repoRow?.id,
			messageCount: existingSession.getMessages().length,
			activeRequest: activeReq,
		});
	}

	// Load the DB session
	const dbSession = getSession(sessionId);
	if (!dbSession) {
		return c.json({ success: false, error: "Session not found in database" }, 404);
	}

	const db = getDb();

	// Load the repository by ID
	const repoRow = db
		.query<{ git_url: string; summary: string | null; id: number }, [number]>(
			"SELECT id, git_url, summary FROM repositories WHERE id = ?",
		)
		.get(dbSession.repository_id);

	if (!repoRow) {
		return c.json({ success: false, error: "Repository not found for session" }, 404);
	}

	const restoreStart = Date.now();
	try {
		// Look up the commit from the checkout record
		let commitish: string | undefined;
		if (dbSession.checkout_id) {
			const checkoutRow = db
				.query<{ commit_id: string }, [number]>("SELECT commit_id FROM checkouts WHERE id = ?")
				.get(dbSession.checkout_id);
			commitish = checkoutRow?.commit_id;
		}

		// Reconnect to the repository at the same commit
		const session = wrapSession(await askForgeClient.connect(repoRow.git_url, { commitish }), sessionId);

		// Load messages from DB and restore them, considering compaction
		const compaction = getLatestCompaction(sessionId);
		const dbMessages = compaction ? getNonCompactedMessages(sessionId) : getMessagesBySession(sessionId);

		if (dbMessages.length > 0 || compaction) {
			const messages = buildSessionContext(dbMessages, compaction);
			session.replaceMessages(messages);
		}

		// Store the session in memory and mark as active
		sessions.set(session.id, session);
		sessionTimestamps.set(session.id, Date.now());
		updateSessionStatus(sessionId, "active");

		// Check if there's an active streaming request for this session
		const activeReq = getActiveRequest(sessionId);

		sessionLogger.info(
			"Session restored: {sessionId} with {messageCount} messages, compacted={hasCompaction} ({durationMs}ms)",
			{
				sessionId,
				repoUrl: repoRow.git_url,
				messageCount: dbMessages.length,
				hasCompaction: !!compaction,
				durationMs: Date.now() - restoreStart,
			},
		);

		return c.json({
			success: true,
			sessionId: session.id,
			normalized: repoRow.git_url,
			localPath: session.repo.localPath,
			commitish: session.repo.commitish,
			summary: repoRow.summary,
			repositoryId: repoRow.id,
			messageCount: dbMessages.length,
			activeRequest: activeReq,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		sessionLogger.error("Session restore failed for {sessionId}: {error} ({durationMs}ms)", {
			sessionId,
			error: message,
			durationMs: Date.now() - restoreStart,
		});
		return c.json({ success: false, error: message }, 500);
	}
});

/**
 * Close a session
 */
api.post("/disconnect", createAuthMiddleware(), async (c) => {
	const body = await c.req.json<{ sessionId: string }>();
	const { sessionId } = body;

	if (!sessionId) {
		return c.json({ success: false, error: "sessionId is required" }, 400);
	}

	const session = sessions.get(sessionId);
	if (session) {
		await session.close();
		sessions.delete(sessionId);
		sessionTimestamps.delete(sessionId);
	}
	updateSessionStatus(sessionId, "inactive");
	sessionLogger.info("Session disconnected: {sessionId}", { sessionId });

	return c.json({ success: true });
});

/**
 * List sessions for the current user with repository info
 */
api.get("/sessions", createAuthMiddleware(), (c) => {
	const payload = getUserFromContext(c);
	if (!payload) return c.json([], 401);

	const db = getDb();
	const rows = db
		.query<
			{
				id: string;
				title: string | null;
				status: string;
				created_at: string;
				repository_name: string;
				username_or_organization: string;
				git_url: string;
			},
			[number]
		>(
			`SELECT s.id, s.title, s.status, s.created_at,
				r.repository_name, r.username_or_organization, r.git_url
			 FROM sessions s
			 JOIN repositories r ON s.repository_id = r.id
			 WHERE s.user_id = ?
			 ORDER BY s.created_at DESC`,
		)
		.all(payload.sub);

	return c.json(rows);
});

/**
 * Get messages for a session
 */
api.get("/sessions/:id/messages", createAuthMiddleware(), (c) => {
	const sessionId = c.req.param("id");
	const messages = getMessagesBySession(sessionId);
	return c.json(messages);
});

/**
 * Rename a session
 */
api.patch("/sessions/:id", createAuthMiddleware(), async (c) => {
	const sessionId = c.req.param("id");
	const body = await c.req.json<{ title: string }>();

	if (!body.title?.trim()) {
		return c.json({ success: false, error: "Title is required" }, 400);
	}

	updateSessionTitle(sessionId, body.title.trim());
	return c.json({ success: true });
});

/**
 * Delete a session
 */
api.delete("/sessions/:id", createAuthMiddleware(), (c) => {
	const sessionId = c.req.param("id");

	// Close in-memory session if active
	const session = sessions.get(sessionId);
	if (session) {
		session.close();
		sessions.delete(sessionId);
		sessionTimestamps.delete(sessionId);
	}

	deleteSession(sessionId);
	sessionLogger.info("Session deleted: {sessionId}", { sessionId });
	return c.json({ success: true });
});

/**
 * Create a share link for a session (auth required)
 */
api.post("/sessions/:id/share", createAuthMiddleware(), (c) => {
	const sessionId = c.req.param("id");
	const payload = getUserFromContext(c);
	if (!payload) return c.json({ error: "Unauthorized" }, 401);

	// Session must exist either in DB or in memory
	const dbSession = getSession(sessionId);
	const memSession = sessions.get(sessionId);
	if (!dbSession && !memSession) return c.json({ error: "Session not found" }, 404);

	// If session is in memory but missing from DB, create the DB record
	if (!dbSession && memSession) {
		const db = getDb();
		const repoRow = db
			.query<{ id: number }, [string]>("SELECT id FROM repositories WHERE git_url = ?")
			.get(memSession.repo.url);
		if (repoRow) {
			try {
				createDbSession({
					id: sessionId,
					userId: payload.sub,
					repositoryId: repoRow.id,
				});
			} catch {
				return c.json({ error: "Failed to persist session" }, 500);
			}
		} else {
			return c.json({ error: "Repository not found" }, 404);
		}
	}

	// Ensure messages are persisted from in-memory session
	if (memSession) {
		const existingMessages = getMessagesBySession(sessionId);
		if (existingMessages.length === 0) {
			const msgs = memSession.getMessages();
			for (let i = 0; i < msgs.length; i++) {
				const msg = msgs[i];
				if (msg.role === "user") {
					const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
					createMessage({ sessionId, role: "user", ordinal: i, content });
				} else if (msg.role === "assistant") {
					const content = JSON.stringify(msg.content);
					createMessage({ sessionId, role: "assistant", ordinal: i, content });
				} else if (msg.role === "toolResult") {
					const contentText = msg.content.map((ct: { text?: string }) => ct.text ?? "").join("");
					createMessage({ sessionId, role: "tool", ordinal: i, content: contentText, toolName: msg.toolName });
				}
			}
		}
	}

	const shareLink = createShareLink(sessionId, payload.sub);
	const shareUrl = `/share/${shareLink.share_token}`;

	return c.json({ shareToken: shareLink.share_token, shareUrl });
});

/**
 * Delete a share link for a session (auth required)
 */
api.delete("/sessions/:id/share", createAuthMiddleware(), (c) => {
	const sessionId = c.req.param("id");
	const payload = getUserFromContext(c);
	if (!payload) return c.json({ error: "Unauthorized" }, 401);

	deleteShareLink(sessionId);
	return c.json({ success: true });
});

/**
 * Get shared session data (public - no auth required)
 */
api.get("/share/:token", (c) => {
	const token = c.req.param("token");
	const shareLink = getShareLink(token);

	if (!shareLink) {
		return c.json({ error: "Share link not found" }, 404);
	}

	const messages = getMessagesBySession(shareLink.session_id);

	return c.json({
		session: {
			title: shareLink.title,
			repoName: shareLink.repository_name,
			gitUrl: shareLink.git_url,
			commitish: shareLink.commitish,
			createdAt: shareLink.session_created_at,
		},
		messages,
	});
});

export default api;
