/**
 * Normalize various git URL formats to a cloneable https URL.
 *
 * Supports:
 * - https clone URLs: https://github.com/user/repo.git
 * - ssh URLs: git@github.com:user/repo.git
 * - Forge landing pages: https://github.com/user/repo
 *
 * Popular forges supported:
 * - GitHub
 * - GitLab
 * - Bitbucket
 * - Codeberg
 * - SourceHut
 * - Gitea (common self-hosted)
 */

const FORGE_PATTERNS: Array<{
	name: string;
	pattern: RegExp;
	toHttps: (match: RegExpMatchArray) => string;
}> = [
	// SSH format: git@github.com:user/repo.git
	{
		name: "ssh",
		pattern: /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/,
		toHttps: (m) => `https://${m[1]}/${m[2]}/${m[3]}.git`,
	},
	// SSH format with ssh:// prefix: ssh://git@github.com/user/repo.git
	{
		name: "ssh-prefix",
		pattern: /^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/,
		toHttps: (m) => `https://${m[1]}/${m[2]}/${m[3]}.git`,
	},
	// git:// protocol
	{
		name: "git-protocol",
		pattern: /^git:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/,
		toHttps: (m) => `https://${m[1]}/${m[2]}/${m[3]}.git`,
	},
	// HTTPS URLs (with or without .git)
	{
		name: "https",
		pattern: /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/,
		toHttps: (m) => `https://${m[1]}/${m[2]}/${m[3]}.git`,
	},
	// HTTPS URLs with deeper paths (e.g., gitlab subgroups or extra path segments)
	{
		name: "https-deep",
		pattern: /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/,
		toHttps: (m) => {
			const path = m[2]?.replace(/\/$/, "") ?? "";
			return `https://${m[1]}/${path}.git`;
		},
	},
];

export interface NormalizeResult {
	normalized: string | null;
	error: string | null;
}

export function normalizeGitUrl(input: string): NormalizeResult {
	const trimmed = input.trim();

	if (!trimmed) {
		return { normalized: null, error: "URL is required" };
	}

	for (const { pattern, toHttps } of FORGE_PATTERNS) {
		const match = trimmed.match(pattern);
		if (match) {
			return { normalized: toHttps(match), error: null };
		}
	}

	return { normalized: null, error: "Unrecognized git URL format" };
}

/**
 * Extract forge name from a normalized URL
 */
export function inferForgeName(url: string): string | null {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();

		if (host === "github.com") return "github";
		if (host === "gitlab.com") return "gitlab";
		if (host === "bitbucket.org") return "bitbucket";
		if (host === "codeberg.org") return "codeberg";
		if (host === "git.sr.ht") return "sourcehut";

		// Generic / self-hosted
		return "git";
	} catch {
		return null;
	}
}
