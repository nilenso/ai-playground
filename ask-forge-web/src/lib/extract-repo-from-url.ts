/**
 * Extract a repository URL from a forge page URL.
 *
 * Handles deep links like:
 * - https://github.com/user/repo/blob/main/README.md
 * - https://github.com/user/repo/issues/123
 * - https://gitlab.com/group/subgroup/repo/-/merge_requests/1
 *
 * Returns the base repo URL or null if not a recognized forge.
 */

// Known forge domains and their repo extraction patterns
const FORGE_EXTRACTORS: Array<{
	domain: string;
	// Extract [user/org, repo] from the pathname
	extract: (pathname: string) => [string, string] | null;
}> = [
	{
		domain: "github.com",
		extract: (pathname) => {
			// /user/repo/... -> [user, repo]
			const match = pathname.match(/^\/([^/]+)\/([^/]+)/);
			if (match && match[1] && match[2]) {
				// Skip special GitHub paths that aren't repos
				const reserved = ["settings", "organizations", "marketplace", "explore", "topics", "trending", "collections", "events", "sponsors", "features", "security", "pulls", "issues", "notifications"];
				if (reserved.includes(match[1].toLowerCase())) return null;
				return [match[1], match[2]];
			}
			return null;
		},
	},
	{
		domain: "gitlab.com",
		extract: (pathname) => {
			// GitLab can have subgroups: /group/subgroup/repo/-/...
			// Split by /-/ to separate repo path from action path
			const repoPath = pathname.split("/-/")[0];
			const parts = repoPath?.split("/").filter(Boolean);
			if (parts && parts.length >= 2) {
				// Last part is repo, everything before is group/subgroup
				const repo = parts.pop()!;
				const group = parts.join("/");
				return [group, repo];
			}
			return null;
		},
	},
	{
		domain: "bitbucket.org",
		extract: (pathname) => {
			const match = pathname.match(/^\/([^/]+)\/([^/]+)/);
			if (match && match[1] && match[2]) {
				return [match[1], match[2]];
			}
			return null;
		},
	},
	{
		domain: "codeberg.org",
		extract: (pathname) => {
			const match = pathname.match(/^\/([^/]+)\/([^/]+)/);
			if (match && match[1] && match[2]) {
				return [match[1], match[2]];
			}
			return null;
		},
	},
	{
		domain: "git.sr.ht",
		extract: (pathname) => {
			// SourceHut: /~user/repo
			const match = pathname.match(/^\/(~[^/]+)\/([^/]+)/);
			if (match && match[1] && match[2]) {
				return [match[1], match[2]];
			}
			return null;
		},
	},
];

export interface ExtractResult {
	repoUrl: string | null;
	error: string | null;
}

export function extractRepoFromUrl(url: string): ExtractResult {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { repoUrl: null, error: "Invalid URL" };
	}

	const hostname = parsed.hostname.toLowerCase();

	for (const { domain, extract } of FORGE_EXTRACTORS) {
		if (hostname === domain || hostname.endsWith(`.${domain}`)) {
			const result = extract(parsed.pathname);
			if (result) {
				const [owner, repo] = result;
				return {
					repoUrl: `https://${hostname}/${owner}/${repo}`,
					error: null,
				};
			}
		}
	}

	return { repoUrl: null, error: "Not a recognized code forge URL" };
}

/**
 * Check if a URL is from a known forge domain.
 */
export function isForgeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		return FORGE_EXTRACTORS.some(
			({ domain }) => hostname === domain || hostname.endsWith(`.${domain}`)
		);
	} catch {
		return false;
	}
}
