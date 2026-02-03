import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/ask-forge.db";

// Lazy initialization of database connection
let db: Database | null = null;

export function getDb(): Database {
	if (!db) {
		// Ensure the directory exists
		const dir = dirname(DB_PATH);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		db = new Database(DB_PATH);
		db.exec("PRAGMA foreign_keys = ON");
	}
	return db;
}

export interface Repository {
	id: number;
	user_input_url: string;
	git_url: string;
	default_commit: string;
	summary: string | null;
	repository_name: string;
	username_or_organization: string;
	forge_domain: string;
	created_at: string;
	summary_last_computed_at: string | null;
	summary_last_computed_for: string | null;
}

export interface Checkout {
	id: number;
	repository_id: number;
	commit_id: string;
	short_id: string;
	created_at: string;
}

/**
 * Parse repository metadata from a normalized git URL
 */
export function parseGitUrl(gitUrl: string): {
	forgeDomain: string;
	usernameOrOrg: string;
	repoName: string;
} {
	const url = new URL(gitUrl);
	const forgeDomain = url.hostname;
	const pathParts = url.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/");

	return {
		forgeDomain,
		usernameOrOrg: pathParts[0] || "",
		repoName: pathParts[1] || pathParts[0] || "",
	};
}

/**
 * Find or create a repository record
 * Returns the repository with its ID
 */
export function findOrCreateRepository(params: {
	userInputUrl: string;
	gitUrl: string;
	defaultCommit: string;
	summary?: string | null;
}): Repository {
	const db = getDb();
	const { userInputUrl, gitUrl, defaultCommit, summary } = params;
	const { forgeDomain, usernameOrOrg, repoName } = parseGitUrl(gitUrl);

	// Check if repository already exists
	const existing = db.query<Repository, [string]>("SELECT * FROM repositories WHERE git_url = ?").get(gitUrl);

	if (existing) {
		// Update summary if provided and not already set
		if (summary && !existing.summary) {
			const now = new Date().toISOString();
			db.run(
				`UPDATE repositories 
				 SET summary = ?, summary_last_computed_at = ?, summary_last_computed_for = ?
				 WHERE id = ?`,
				[summary, now, defaultCommit, existing.id],
			);
			return {
				...existing,
				summary,
				summary_last_computed_at: now,
				summary_last_computed_for: defaultCommit,
			};
		}
		return existing;
	}

	// Insert new repository
	const now = new Date().toISOString();
	const result = db.run(
		`INSERT INTO repositories 
		 (user_input_url, git_url, default_commit, summary, repository_name, username_or_organization, forge_domain, created_at, summary_last_computed_at, summary_last_computed_for)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			userInputUrl,
			gitUrl,
			defaultCommit,
			summary || null,
			repoName,
			usernameOrOrg,
			forgeDomain,
			now,
			summary ? now : null,
			summary ? defaultCommit : null,
		],
	);

	return {
		id: Number(result.lastInsertRowid),
		user_input_url: userInputUrl,
		git_url: gitUrl,
		default_commit: defaultCommit,
		summary: summary || null,
		repository_name: repoName,
		username_or_organization: usernameOrOrg,
		forge_domain: forgeDomain,
		created_at: now,
		summary_last_computed_at: summary ? now : null,
		summary_last_computed_for: summary ? defaultCommit : null,
	};
}

/**
 * Record a checkout for a repository
 */
export function recordCheckout(params: { repositoryId: number; commitId: string }): Checkout {
	const db = getDb();
	const { repositoryId, commitId } = params;
	const shortId = commitId.slice(0, 7);

	// Check if checkout already exists
	const existing = db
		.query<Checkout, [number, string]>("SELECT * FROM checkouts WHERE repository_id = ? AND commit_id = ?")
		.get(repositoryId, commitId);

	if (existing) {
		return existing;
	}

	// Insert new checkout
	const now = new Date().toISOString();
	const result = db.run(
		`INSERT INTO checkouts (repository_id, commit_id, short_id, created_at)
		 VALUES (?, ?, ?, ?)`,
		[repositoryId, commitId, shortId, now],
	);

	return {
		id: Number(result.lastInsertRowid),
		repository_id: repositoryId,
		commit_id: commitId,
		short_id: shortId,
		created_at: now,
	};
}

/**
 * Get repository by git URL
 */
export function getRepositoryByGitUrl(gitUrl: string): Repository | null {
	const db = getDb();
	return db.query<Repository, [string]>("SELECT * FROM repositories WHERE git_url = ?").get(gitUrl) || null;
}

/**
 * Update repository summary
 */
export function updateRepositorySummary(params: { repositoryId: number; summary: string; commit: string }): void {
	const db = getDb();
	const now = new Date().toISOString();
	db.run(
		`UPDATE repositories
		 SET summary = ?, summary_last_computed_at = ?, summary_last_computed_for = ?
		 WHERE id = ?`,
		[params.summary, now, params.commit, params.repositoryId],
	);
}

// ─── Session types and functions ────────────────────────────────────────────

export interface DbSession {
	id: string;
	user_id: number;
	repository_id: number;
	checkout_id: number | null;
	title: string | null;
	status: string;
	created_at: string;
	ended_at: string | null;
}

export interface DbMessage {
	id: number;
	session_id: string;
	role: string;
	content: string | null;
	thinking: string | null;
	tool_name: string | null;
	tool_arguments: string | null;
	tool_result: string | null;
	ordinal: number;
	created_at: string;
}

export interface DbMessageFeedback {
	id: number;
	message_id: number;
	feedback: string;
	created_at: string;
}

export interface DbUsageStats {
	id: number;
	session_id: string;
	message_id: number;
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	inference_time_ms: number;
}

/**
 * Create a new session
 */
export function createSession(params: {
	id: string;
	userId: number;
	repositoryId: number;
	checkoutId?: number | null;
	title?: string | null;
}): DbSession {
	const db = getDb();
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO sessions (id, user_id, repository_id, checkout_id, title, status, created_at)
		 VALUES (?, ?, ?, ?, ?, 'active', ?)`,
		[params.id, params.userId, params.repositoryId, params.checkoutId ?? null, params.title ?? null, now],
	);

	return {
		id: params.id,
		user_id: params.userId,
		repository_id: params.repositoryId,
		checkout_id: params.checkoutId ?? null,
		title: params.title ?? null,
		status: "active",
		created_at: now,
		ended_at: null,
	};
}

/**
 * Get a session by ID
 */
export function getSession(id: string): DbSession | null {
	const db = getDb();
	return db.query<DbSession, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) || null;
}

/**
 * Update session status (and set ended_at for terminal states)
 */
export function updateSessionStatus(id: string, status: string): void {
	const db = getDb();
	const endedAt = status !== "active" ? new Date().toISOString() : null;
	db.run("UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?", [status, endedAt, id]);
}

/**
 * Delete a session by ID (CASCADE handles messages/feedback/usage)
 */
export function deleteSession(id: string): void {
	const db = getDb();
	db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/**
 * Update session title
 */
export function updateSessionTitle(id: string, title: string): void {
	const db = getDb();
	db.run("UPDATE sessions SET title = ? WHERE id = ?", [title, id]);
}

/**
 * List sessions for a user, ordered by most recent first
 */
export function listSessionsByUser(userId: number, options?: { repositoryId?: number; status?: string }): DbSession[] {
	const db = getDb();
	const conditions = ["user_id = ?"];
	const params: (string | number)[] = [userId];

	if (options?.repositoryId) {
		conditions.push("repository_id = ?");
		params.push(options.repositoryId);
	}
	if (options?.status) {
		conditions.push("status = ?");
		params.push(options.status);
	}

	const sql = `SELECT * FROM sessions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
	return db.query<DbSession, (string | number)[]>(sql).all(...params);
}

/**
 * Create a message in a session
 */
export function createMessage(params: {
	sessionId: string;
	role: string;
	ordinal: number;
	content?: string | null;
	thinking?: string | null;
	toolName?: string | null;
	toolArguments?: string | null;
	toolResult?: string | null;
}): DbMessage {
	const db = getDb();
	const now = new Date().toISOString();
	const result = db.run(
		`INSERT OR IGNORE INTO messages (session_id, role, content, thinking, tool_name, tool_arguments, tool_result, ordinal, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.sessionId,
			params.role,
			params.content ?? null,
			params.thinking ?? null,
			params.toolName ?? null,
			params.toolArguments ?? null,
			params.toolResult ?? null,
			params.ordinal,
			now,
		],
	);

	return {
		id: Number(result.lastInsertRowid),
		session_id: params.sessionId,
		role: params.role,
		content: params.content ?? null,
		thinking: params.thinking ?? null,
		tool_name: params.toolName ?? null,
		tool_arguments: params.toolArguments ?? null,
		tool_result: params.toolResult ?? null,
		ordinal: params.ordinal,
		created_at: now,
	};
}

/**
 * Get all messages for a session, ordered by ordinal
 */
export function getMessagesBySession(sessionId: string): DbMessage[] {
	const db = getDb();
	return db.query<DbMessage, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal").all(sessionId);
}

/**
 * Set feedback (like/dislike) for a message, upserting
 */
export function setMessageFeedback(messageId: number, feedback: string): DbMessageFeedback {
	const db = getDb();
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO message_feedback (message_id, feedback, created_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(message_id) DO UPDATE SET feedback = excluded.feedback, created_at = excluded.created_at`,
		[messageId, feedback, now],
	);

	const row = db
		.query<DbMessageFeedback, [number]>("SELECT * FROM message_feedback WHERE message_id = ?")
		.get(messageId);
	return row as DbMessageFeedback;
}

/**
 * Record token usage stats for a message
 */
// ─── Share link types and functions ──────────────────────────────────────────

export interface DbShareLink {
	id: number;
	session_id: string;
	share_token: string;
	created_by: number;
	created_at: string;
}

/**
 * Create a share link for a session. Returns existing link if one already exists.
 */
export function createShareLink(sessionId: string, userId: number): DbShareLink {
	const db = getDb();

	// Check if a share link already exists
	const existing = db.query<DbShareLink, [string]>("SELECT * FROM share_links WHERE session_id = ?").get(sessionId);
	if (existing) return existing;

	// Generate a random token
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	const shareToken = Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");

	const now = new Date().toISOString();
	const result = db.run(
		"INSERT INTO share_links (session_id, share_token, created_by, created_at) VALUES (?, ?, ?, ?)",
		[sessionId, shareToken, userId, now],
	);

	return {
		id: Number(result.lastInsertRowid),
		session_id: sessionId,
		share_token: shareToken,
		created_by: userId,
		created_at: now,
	};
}

/**
 * Get a share link by token, joined with session and repository info
 */
export function getShareLink(shareToken: string):
	| (DbShareLink & {
			title: string | null;
			repository_name: string;
			git_url: string;
			commitish: string | null;
			session_created_at: string;
	  })
	| null {
	const db = getDb();
	return (
		db
			.query<
				DbShareLink & {
					title: string | null;
					repository_name: string;
					git_url: string;
					commitish: string | null;
					session_created_at: string;
				},
				[string]
			>(
				`SELECT sl.*, s.title,
				r.username_or_organization || '/' || r.repository_name as repository_name,
				r.git_url,
				COALESCE(c.commit_id, r.default_commit) as commitish,
				s.created_at as session_created_at
			 FROM share_links sl
			 JOIN sessions s ON sl.session_id = s.id
			 JOIN repositories r ON s.repository_id = r.id
			 LEFT JOIN checkouts c ON s.checkout_id = c.id
			 WHERE sl.share_token = ?`,
			)
			.get(shareToken) || null
	);
}

/**
 * Get share link by session ID
 */
export function getShareLinkBySession(sessionId: string): DbShareLink | null {
	const db = getDb();
	return db.query<DbShareLink, [string]>("SELECT * FROM share_links WHERE session_id = ?").get(sessionId) || null;
}

/**
 * Delete share link for a session
 */
export function deleteShareLink(sessionId: string): void {
	const db = getDb();
	db.run("DELETE FROM share_links WHERE session_id = ?", [sessionId]);
}

export function createUsageStats(params: {
	sessionId: string;
	messageId: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	inferenceTimeMs: number;
}): DbUsageStats {
	const db = getDb();
	const result = db.run(
		`INSERT INTO usage_stats (session_id, message_id, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, inference_time_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.sessionId,
			params.messageId,
			params.inputTokens,
			params.outputTokens,
			params.totalTokens,
			params.cacheReadTokens ?? 0,
			params.cacheWriteTokens ?? 0,
			params.inferenceTimeMs,
		],
	);

	return {
		id: Number(result.lastInsertRowid),
		session_id: params.sessionId,
		message_id: params.messageId,
		input_tokens: params.inputTokens,
		output_tokens: params.outputTokens,
		total_tokens: params.totalTokens,
		cache_read_tokens: params.cacheReadTokens ?? 0,
		cache_write_tokens: params.cacheWriteTokens ?? 0,
		inference_time_ms: params.inferenceTimeMs,
	};
}
