import { Hono } from "hono";
import { connect } from "ask-forge";
import { normalizeGitUrl } from "../lib/normalize-url.ts";
import {
	findOrCreateRepository,
	recordCheckout,
	getRepositoryByGitUrl,
	updateRepositorySummary,
} from "../lib/db.ts";

// Git environment to prevent interactive prompts and SSH key loading
const GIT_ENV: Record<string, string> = {
	// Disable SSH agent and key loading
	SSH_AUTH_SOCK: "",
	// Use a non-existent SSH key to prevent loading default keys
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	// Disable terminal prompts for credentials
	GIT_TERMINAL_PROMPT: "0",
	// Disable askpass programs
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	// Preserve PATH for git to work
	PATH: process.env.PATH || "",
};

const api = new Hono();

api.get("/health", (c) => {
	return c.json({ status: "ok" });
});

/**
 * Validate a git URL by checking if it's cloneable
 * Uses git ls-remote to check without actually cloning
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

	// Use git ls-remote to check if the repo is accessible
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
 * Connect to a repository and ask an initial question about it
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
		// Connect to the repository (this clones it and creates a session)
		// If commit is provided, use it; otherwise connect will use default branch
		const session = await connect(normalized, { commitish: commit });

		// Check if we already have a cached summary for this repo
		const existingRepo = getRepositoryByGitUrl(normalized);
		let summary: string;
		let shouldComputeSummary = true;

		if (existingRepo?.summary) {
			// Use cached summary
			summary = existingRepo.summary;
			shouldComputeSummary = false;
		} else {
			// Ask for a quick summary based on the README (faster than exploring the repo)
			const result = await session.ask(
				`Summarize the README file in markdown. Keep it brief. Do not include a title or header - start directly with the content.`
			);
			summary = result.response;
		}

		// Close the session
		session.close();

		// Save/update repository record
		const repository = findOrCreateRepository({
			userInputUrl: url,
			gitUrl: normalized,
			defaultCommit: session.repo.commitish,
			summary: shouldComputeSummary ? summary : undefined,
		});

		// Update summary if we computed a new one and repo already existed
		if (shouldComputeSummary && existingRepo && !existingRepo.summary) {
			updateRepositorySummary({
				repositoryId: repository.id,
				summary,
				commit: session.repo.commitish,
			});
		}

		// Record this checkout
		recordCheckout({
			repositoryId: repository.id,
			commitId: session.repo.commitish,
		});

		return c.json({
			success: true,
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

export default api;
