import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
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
	const pathParts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
	
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
	const existing = db.query<Repository, [string]>(
		"SELECT * FROM repositories WHERE git_url = ?"
	).get(gitUrl);

	if (existing) {
		// Update summary if provided and not already set
		if (summary && !existing.summary) {
			const now = new Date().toISOString();
			db.run(
				`UPDATE repositories 
				 SET summary = ?, summary_last_computed_at = ?, summary_last_computed_for = ?
				 WHERE id = ?`,
				[summary, now, defaultCommit, existing.id]
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
		]
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
export function recordCheckout(params: {
	repositoryId: number;
	commitId: string;
}): Checkout {
	const db = getDb();
	const { repositoryId, commitId } = params;
	const shortId = commitId.slice(0, 7);

	// Check if checkout already exists
	const existing = db.query<Checkout, [number, string]>(
		"SELECT * FROM checkouts WHERE repository_id = ? AND commit_id = ?"
	).get(repositoryId, commitId);

	if (existing) {
		return existing;
	}

	// Insert new checkout
	const now = new Date().toISOString();
	const result = db.run(
		`INSERT INTO checkouts (repository_id, commit_id, short_id, created_at)
		 VALUES (?, ?, ?, ?)`,
		[repositoryId, commitId, shortId, now]
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
	return db.query<Repository, [string]>(
		"SELECT * FROM repositories WHERE git_url = ?"
	).get(gitUrl) || null;
}

/**
 * Update repository summary
 */
export function updateRepositorySummary(params: {
	repositoryId: number;
	summary: string;
	commit: string;
}): void {
	const db = getDb();
	const now = new Date().toISOString();
	db.run(
		`UPDATE repositories 
		 SET summary = ?, summary_last_computed_at = ?, summary_last_computed_for = ?
		 WHERE id = ?`,
		[params.summary, now, params.commit, params.repositoryId]
	);
}
