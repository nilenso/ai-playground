/**
 * Sandbox worker — HTTP server that runs inside an isolated container.
 *
 * Defense in depth:
 *   Layer 1 — bwrap (bubblewrap): per-operation filesystem and namespace
 *             isolation. Tool calls are scoped to their worktree with no
 *             network and no visibility of other processes. Git clones get
 *             write access only to their target directory with hooks disabled.
 *   Layer 2 — gVisor (runsc): the container runtime provides kernel-level
 *             syscall sandboxing.
 *   Layer 3 — Path validation in the worker code itself.
 *
 * Endpoints:
 *   POST /clone   { url, commitish? }  → clone a repo, check out a commit
 *   POST /tool    { slug, sha, name, args }  → execute a tool (rg, fd, ls, read)
 *   GET  /health                       → liveness check
 *   POST /reset                        → delete all cloned data
 *
 * The container's compose network provides outbound access for git clone.
 * Tool execution has no network access (bwrap --unshare-net).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT) || 8080;
const REPO_BASE = "/home/forge/repos";

// =============================================================================
// Helpers
// =============================================================================

// Git environment to prevent interactive prompts
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND:
		"ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/home/forge",
};

async function run(
	cmd: string[],
	cwd?: string,
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? process.env,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { stdout, stderr, exitCode: await proc.exited };
}

/**
 * Shell-escape a single argument for safe inclusion in a command string.
 */
function shellEscape(arg: string): string {
	if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) {
		return arg;
	}
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

function repoDir(id: string): string {
	return `${REPO_BASE}/${id}`;
}

/** Turn a repo URL into a safe filesystem slug. */
function slugify(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
	} catch {
		return url.replace(/[^a-zA-Z0-9._-]/g, "_");
	}
}

/**
 * Validate that a resolved path stays within the worktree root.
 * Defense-in-depth: bwrap is the primary per-session boundary, gVisor is the
 * container boundary, and this prevents traversal within the worktree.
 */
function validatePath(worktree: string, userPath: string): string | null {
	const full = resolve(worktree, userPath);
	if (!full.startsWith(resolve(worktree))) {
		return null;
	}
	return full;
}

// =============================================================================
// bwrap wrappers
// =============================================================================

/**
 * Build bwrap args for git clone/fetch/worktree operations.
 *
 * Filesystem: read-only root, writable only to the specific repo directory.
 * Network: NOT isolated (needs to reach git remotes). TODO: add proxy filtering.
 * Hooks: disabled via git config.
 * PID: isolated.
 */
function bwrapArgsForGit(repoBaseDir: string): string[] {
	return [
		"bwrap",
		// Read-only root filesystem
		"--ro-bind", "/", "/",
		// Writable: the specific repo directory
		"--bind", repoBaseDir, repoBaseDir,
		// Writable: /tmp for git's temporary files
		"--tmpfs", "/tmp",
		// Fresh /dev
		"--dev", "/dev",
		// PID isolation — git can't see/signal other processes
		"--unshare-pid",
		"--proc", "/proc",
		// Hide sensitive paths
		"--tmpfs", "/home/forge/.ssh",
		"--tmpfs", "/home/forge/.gnupg",
		// Die if parent dies
		"--die-with-parent",
		"--",
	];
}

/**
 * Build bwrap args for tool execution (rg, find, ls, cat, etc).
 *
 * Filesystem: read-only root, with /home/forge/repos replaced by tmpfs
 *             and only the specific worktree bind-mounted back through.
 * Network: fully isolated (--unshare-net).
 * PID: isolated.
 */
function bwrapArgsForTool(worktree: string): string[] {
	return [
		"bwrap",
		// Read-only root filesystem
		"--ro-bind", "/", "/",
		// Hide ALL repos, then punch through only this worktree
		"--tmpfs", REPO_BASE,
		"--ro-bind", worktree, worktree,
		// Fresh /dev
		"--dev", "/dev",
		// No network
		"--unshare-net",
		// PID isolation
		"--unshare-pid",
		"--proc", "/proc",
		// Hide sensitive paths
		"--tmpfs", "/home/forge/.ssh",
		"--tmpfs", "/home/forge/.gnupg",
		// Die if parent dies
		"--die-with-parent",
		"--",
	];
}

/**
 * Run a git command inside bwrap with filesystem + PID isolation.
 * Git hooks are disabled via config flags.
 */
async function runGitSandboxed(
	gitArgs: string[],
	cwd: string | undefined,
	repoBaseDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cmd = [
		...bwrapArgsForGit(repoBaseDir),
		"git",
		// Disable hooks to prevent arbitrary code execution from malicious repos
		"-c", "core.hooksPath=/dev/null",
		"-c", "protocol.allow=never",
		"-c", "protocol.https.allow=always",
		"-c", "protocol.http.allow=always",
		...gitArgs,
	];

	return run(cmd, cwd, { ...GIT_ENV });
}

/**
 * Run a tool command inside bwrap with per-worktree isolation + no network.
 */
async function runToolSandboxed(
	cmd: string[],
	worktree: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const fullCmd = [
		...bwrapArgsForTool(worktree),
		...cmd,
	];

	return run(fullCmd, worktree);
}

// =============================================================================
// Clone
// =============================================================================

interface CloneRequest {
	url: string;
	commitish?: string;
}

async function handleClone(body: CloneRequest): Promise<Response> {
	const { url, commitish = "HEAD" } = body;
	if (!url) {
		return Response.json({ ok: false, error: "url is required" }, { status: 400 });
	}

	const slug = slugify(url);
	const baseDir = repoDir(slug);
	const bareDir = `${baseDir}/bare`;
	const treesDir = `${baseDir}/trees`;

	try {
		// Ensure directories exist (run outside bwrap — bwrap needs them to exist for bind mounts)
		await Bun.spawn(["mkdir", "-p", bareDir, treesDir]).exited;

		// Clone or fetch
		const headFile = Bun.file(`${bareDir}/HEAD`);
		if (await headFile.exists()) {
			const { exitCode, stderr } = await runGitSandboxed(
				["fetch", "origin", "--tags"],
				bareDir,
				baseDir,
			);
			if (exitCode !== 0) {
				console.error(`[clone] fetch failed: ${stderr}`);
			}
		} else {
			const { exitCode, stderr } = await runGitSandboxed(
				["clone", "--bare", url, bareDir],
				undefined,
				baseDir,
			);
			if (exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `git clone failed: ${stderr.slice(0, 500)}` },
					{ status: 500 },
				);
			}
		}

		// Resolve commitish → SHA
		const revParse = await runGitSandboxed(
			["rev-parse", commitish],
			bareDir,
			baseDir,
		);
		if (revParse.exitCode !== 0) {
			return Response.json(
				{ ok: false, error: `Cannot resolve commitish "${commitish}": ${revParse.stderr.slice(0, 300)}` },
				{ status: 400 },
			);
		}
		const sha = revParse.stdout.trim();
		const shortSha = sha.slice(0, 12);
		const worktree = `${treesDir}/${shortSha}`;

		// Create worktree if it doesn't exist
		const worktreeExists = await Bun.file(`${worktree}/.git`).exists();
		if (!worktreeExists) {
			const wt = await runGitSandboxed(
				["worktree", "add", worktree, sha],
				bareDir,
				baseDir,
			);
			if (wt.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `git worktree add failed: ${wt.stderr.slice(0, 300)}` },
					{ status: 500 },
				);
			}
		}

		return Response.json({ ok: true, slug, sha, worktree });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ ok: false, error: msg }, { status: 500 });
	}
}

// =============================================================================
// Tool execution
// =============================================================================

interface ToolRequest {
	slug: string;
	sha: string;
	name: string;
	args: Record<string, unknown>;
}

async function handleTool(body: ToolRequest): Promise<Response> {
	const { slug, sha, name, args } = body;
	if (!slug || !sha || !name) {
		return Response.json(
			{ ok: false, error: "slug, sha, and name are required" },
			{ status: 400 },
		);
	}

	const shortSha = sha.slice(0, 12);
	const worktree = `${repoDir(slug)}/trees/${shortSha}`;
	const wtExists = await Bun.file(`${worktree}/.git`).exists();
	if (!wtExists) {
		return Response.json(
			{ ok: false, error: `Worktree not found: ${worktree}` },
			{ status: 404 },
		);
	}

	switch (name) {
		case "rg": {
			const pattern = args.pattern as string;
			const glob = args.glob as string | undefined;
			const cmd = ["rg", "--line-number", pattern];
			if (glob) cmd.push("--glob", glob);
			const result = await runToolSandboxed(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "fd": {
			const pattern = args.pattern as string;
			const type = args.type as "f" | "d" | undefined;
			const cmd = ["find", ".", "-name", `*${pattern}*`];
			if (type === "f") cmd.push("-type", "f");
			else if (type === "d") cmd.push("-type", "d");
			const result = await runToolSandboxed(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "ls": {
			const path = (args.path as string) || ".";
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: true, output: `Error: path traversal not allowed: ${path}` });
			}
			const result = await runToolSandboxed(["ls", "-la", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "read": {
			const path = args.path as string;
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: true, output: `Error: path traversal not allowed: ${path}` });
			}
			try {
				const content = await readFile(fullPath, "utf-8");
				return Response.json({ ok: true, output: content || "(empty file)" });
			} catch (e) {
				return Response.json({ ok: true, output: `Error reading file: ${(e as Error).message}` });
			}
		}
		default:
			return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 400 });
	}
}

// =============================================================================
// Reset (delete all repos)
// =============================================================================

async function handleReset(): Promise<Response> {
	const { exitCode } = await run(["rm", "-rf", REPO_BASE]);
	if (exitCode !== 0) {
		return Response.json({ ok: false, error: "Failed to clean repos" }, { status: 500 });
	}
	await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;
	return Response.json({ ok: true });
}

// =============================================================================
// HTTP Server
// =============================================================================

await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/health" && req.method === "GET") {
			return Response.json({ ok: true });
		}

		if (url.pathname === "/clone" && req.method === "POST") {
			const body = (await req.json()) as CloneRequest;
			return handleClone(body);
		}

		if (url.pathname === "/tool" && req.method === "POST") {
			const body = (await req.json()) as ToolRequest;
			return handleTool(body);
		}

		if (url.pathname === "/reset" && req.method === "POST") {
			return handleReset();
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`[sandbox-worker] Listening on :${server.port}`);
