// Format tool calls in a CLI-like style for display
export function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "ls":
			return `ls ${args.path || "."}`;
		case "Read":
		case "read":
			return `read ${args.file_path || args.path || ""}`;
		case "rg":
		case "Grep":
		case "grep": {
			let cmd = `rg "${args.pattern}"`;
			if (args.glob) cmd += ` --glob "${args.glob}"`;
			if (args.path) cmd += ` ${args.path}`;
			return cmd;
		}
		case "Glob":
		case "glob":
			return `glob "${args.pattern}"${args.path ? ` in ${args.path}` : ""}`;
		case "Bash":
		case "bash": {
			const cmdStr = String(args.command || "");
			return cmdStr.length > 60 ? `bash ${cmdStr.slice(0, 60)}...` : `bash ${cmdStr}`;
		}
		case "Write":
		case "write":
		case "Edit":
		case "edit":
			return `${name.toLowerCase()} ${args.file_path || ""}`;
		default: {
			// For unknown tools, show key=value pairs concisely
			const pairs = Object.entries(args)
				.slice(0, 3)
				.map(([k, v]) => {
					const val = typeof v === "string" ? v : JSON.stringify(v);
					const truncated = val.length > 30 ? `${val.slice(0, 30)}...` : val;
					return `${k}="${truncated}"`;
				});
			return `${name} ${pairs.join(" ")}`;
		}
	}
}

export function extractRepoName(url: string): string {
	// Extract repo name from URL like "https://github.com/owner/repo" -> "owner/repo"
	const match = url.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+\/[^/.]+)/i);
	if (match?.[1]) return match[1];
	// Fallback: just get last two path segments
	const parts = url
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (parts.length >= 2) {
		const owner = parts[parts.length - 2];
		const repo = parts[parts.length - 1];
		if (owner && repo) return `${owner}/${repo}`;
	}
	return url;
}
