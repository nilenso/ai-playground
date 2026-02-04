import hljs from "highlight.js";
import { Marked, type MarkedExtension } from "marked";
import { markedHighlight } from "marked-highlight";

/**
 * Known file extensions that indicate a path is a source file reference.
 * Used as a fallback when the path doesn't contain a "/" separator.
 */
const KNOWN_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"pyi",
	"rs",
	"go",
	"rb",
	"java",
	"kt",
	"kts",
	"scala",
	"c",
	"h",
	"cpp",
	"hpp",
	"cc",
	"hh",
	"cxx",
	"cs",
	"fs",
	"fsx",
	"swift",
	"m",
	"mm",
	"vue",
	"svelte",
	"astro",
	"html",
	"css",
	"scss",
	"sass",
	"less",
	"json",
	"yaml",
	"yml",
	"toml",
	"xml",
	"ini",
	"cfg",
	"md",
	"mdx",
	"rst",
	"txt",
	"sh",
	"bash",
	"zsh",
	"fish",
	"sql",
	"graphql",
	"gql",
	"proto",
	"thrift",
	"dockerfile",
	"makefile",
	"lua",
	"zig",
	"nim",
	"ex",
	"exs",
	"erl",
	"hrl",
	"r",
	"jl",
	"pl",
	"pm",
	"tf",
	"hcl",
]);

/**
 * Regex to match file path references inside backtick code spans.
 * Matches patterns like:
 *   src/server.ts
 *   src/server.ts:42
 *   ./lib/db.ts:10
 *   package.json
 */
const FILE_PATH_RE = /^\.?\/?(([\w@./-]+)\.(\w+))(?::(\d+))?$/;

function looksLikeFilePath(text: string): { filePath: string; line?: string } | null {
	const match = text.match(FILE_PATH_RE);
	if (!match) return null;

	const fullPath = match[1];
	const extension = match[3]?.toLowerCase();
	const line = match[4];

	if (!fullPath || !extension) return null;

	// Exclude paths that start with a dot (hidden/system directories like .crush/, .config/, etc.)
	if (fullPath.startsWith(".")) return null;

	// Must either contain a "/" (clearly a path) or have a known file extension
	const hasSlash = fullPath.includes("/");
	const hasKnownExt = KNOWN_EXTENSIONS.has(extension);

	if (!hasSlash && !hasKnownExt) return null;

	return { filePath: fullPath, line };
}

/**
 * Construct a forge-appropriate blob URL for a file.
 * Currently supports GitHub, GitLab, Bitbucket, and Codeberg.
 */
function buildFileUrl(repoUrl: string, commitish: string, filePath: string, line?: string): string {
	// Strip .git suffix and trailing slashes to get the base browse URL
	const baseUrl = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");

	let url: string;

	if (baseUrl.includes("gitlab.com") || baseUrl.includes("gitlab.")) {
		// GitLab uses /-/blob/
		url = `${baseUrl}/-/blob/${commitish}/${filePath}`;
		if (line) url += `#L${line}`;
	} else if (baseUrl.includes("bitbucket.org")) {
		// Bitbucket uses /src/
		url = `${baseUrl}/src/${commitish}/${filePath}`;
		if (line) url += `#lines-${line}`;
	} else {
		// GitHub, Codeberg, Gitea, and most others use /blob/
		url = `${baseUrl}/blob/${commitish}/${filePath}`;
		if (line) url += `#L${line}`;
	}

	return url;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Create a marked extension that converts file-path code spans into GitHub links.
 */
function createFileLinkExtension(repoUrl: string, commitish: string): MarkedExtension {
	return {
		renderer: {
			codespan({ text }: { text: string }) {
				const result = looksLikeFilePath(text);
				if (!result) {
					return `<code>${escapeHtml(text)}</code>`;
				}

				const url = buildFileUrl(repoUrl, commitish, result.filePath, result.line);
				return `<a class="file-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(text)}</code></a>`;
			},
		},
	};
}

/**
 * Create a configured Marked instance that links file references to the forge
 * and provides syntax highlighting for code blocks.
 * If repoUrl or commitish are missing, file linking is skipped but highlighting still works.
 */
export function createMarkedWithFileLinks(repoUrl?: string | null, commitish?: string | null): Marked {
	const instance = new Marked();

	// Add syntax highlighting for code blocks
	instance.use(
		markedHighlight({
			emptyLangClass: "hljs",
			langPrefix: "hljs language-",
			highlight(code, lang) {
				if (lang && hljs.getLanguage(lang)) {
					return hljs.highlight(code, { language: lang }).value;
				}
				// No language specified or unknown language - return code as-is
				return code;
			},
		}),
	);

	if (repoUrl && commitish) {
		instance.use(createFileLinkExtension(repoUrl, commitish));
	}

	return instance;
}
