import { connect, type Session } from "ask-forge";
import { Hono } from "hono";
import {
	createSession as createDbSession,
	deleteSession,
	findOrCreateRepository,
	getDb,
	getMessagesBySession,
	getRepositoryByGitUrl,
	getSession,
	recordCheckout,
	updateSessionStatus,
	updateSessionTitle,
} from "../lib/db.ts";
import { normalizeGitUrl } from "../lib/normalize-url.ts";
import { buildSessionContext } from "../lib/session-context.ts";
import { wrapSession } from "../lib/session-logger.ts";

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

// Clean up sessions older than 30 minutes
const SESSION_TTL = 10 * 60 * 1000;
export const sessionTimestamps = new Map<string, number>();

function cleanupSessions() {
	const now = Date.now();
	for (const [id, timestamp] of sessionTimestamps) {
		if (now - timestamp > SESSION_TTL) {
			const session = sessions.get(id);
			if (session) {
				session.close();
				sessions.delete(id);
			}
			sessionTimestamps.delete(id);
			updateSessionStatus(id, "inactive");
		}
	}
}

// Run cleanup every 5 minutes
setInterval(cleanupSessions, 5 * 60 * 1000);

const api = new Hono();

api.get("/health", (c) => {
	return c.json({ status: "ok" });
});

/**
 * Validate a git URL by checking if it's cloneable
 */
api.post("/validate", async (c) => {
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
 * Connect to a repository and create a session
 */
api.post("/connect", async (c) => {
	const body = await c.req.json<{ url: string; commit?: string }>();
	const { url, commit } = body;

	if (!url) {
		return c.json({ success: false, error: "URL is required" }, 400);
	}

	const { normalized, error } = normalizeGitUrl(url);

	if (!normalized) {
		return c.json({ success: false, error }, 400);
	}

	try {
		const rawSession = await connect(normalized, { commitish: commit });

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
			userId: 1, // TODO: use authenticated user ID
			repositoryId: repository.id,
			checkoutId: checkout.id,
		});

		const session = wrapSession(rawSession, rawSession.id);

		// Store the session
		sessions.set(session.id, session);
		sessionTimestamps.set(session.id, Date.now());

		return c.json({
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
		return c.json({ success: false, error: message }, 500);
	}
});

/**
 * Ask a question in an existing session (streaming progress via SSE)
 */
api.post("/ask", async (c) => {
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
api.post("/restore", async (c) => {
	const body = await c.req.json<{ sessionId: string }>();
	const { sessionId } = body;

	if (!sessionId) {
		return c.json({ success: false, error: "sessionId is required" }, 400);
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
		const session = wrapSession(await connect(repoRow.git_url, { commitish }), sessionId);

		// Load messages from DB and restore them
		const dbMessages = getMessagesBySession(sessionId);
		if (dbMessages.length > 0) {
			const messages = buildSessionContext(dbMessages);
			session.replaceMessages(messages);
		}

		// Store the session in memory
		sessions.set(session.id, session);
		sessionTimestamps.set(session.id, Date.now());

		return c.json({
			success: true,
			sessionId: session.id,
			normalized: repoRow.git_url,
			localPath: session.repo.localPath,
			commitish: session.repo.commitish,
			summary: repoRow.summary,
			repositoryId: repoRow.id,
			messageCount: dbMessages.length,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return c.json({ success: false, error: message }, 500);
	}
});

/**
 * Close a session
 */
api.post("/disconnect", async (c) => {
	const body = await c.req.json<{ sessionId: string }>();
	const { sessionId } = body;

	if (!sessionId) {
		return c.json({ success: false, error: "sessionId is required" }, 400);
	}

	const session = sessions.get(sessionId);
	if (session) {
		session.close();
		sessions.delete(sessionId);
		sessionTimestamps.delete(sessionId);
	}
	updateSessionStatus(sessionId, "inactive");

	return c.json({ success: true });
});

/**
 * List sessions for the current user with repository info
 */
api.get("/sessions", (c) => {
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
		.all(1); // TODO: use authenticated user ID

	return c.json(rows);
});

/**
 * Get messages for a session
 */
api.get("/sessions/:id/messages", (c) => {
	const sessionId = c.req.param("id");
	const messages = getMessagesBySession(sessionId);
	return c.json(messages);
});

/**
 * Rename a session
 */
api.patch("/sessions/:id", async (c) => {
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
api.delete("/sessions/:id", (c) => {
	const sessionId = c.req.param("id");

	// Close in-memory session if active
	const session = sessions.get(sessionId);
	if (session) {
		session.close();
		sessions.delete(sessionId);
		sessionTimestamps.delete(sessionId);
	}

	deleteSession(sessionId);
	return c.json({ success: true });
});

export default api;
