/**
 * Sandbox integration for ask-forge-web.
 *
 * When SANDBOX_URL is set, tool execution is delegated to an isolated container
 * instead of running locally. This provides security isolation for untrusted code.
 */

import { type Session } from "@nilenso/ask-forge";
import { getModel, stream, type Tool } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";

// Import SandboxClient from the ask-forge sandbox submodule
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of internal module
const sandboxModule: any = await import(
	import.meta.resolve("@nilenso/ask-forge").replace("/index.js", "/sandbox/client.js")
);
const SandboxClient: new (config?: { baseUrl?: string; secret?: string; timeoutMs?: number }) => SandboxClientType =
	sandboxModule.SandboxClient;

// Import config and tools from ask-forge
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of internal module
const askForgeConfig: any = await import(
	import.meta.resolve("@nilenso/ask-forge").replace("/index.js", "/config.js")
);
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of internal module
const askForgeTools: any = await import(
	import.meta.resolve("@nilenso/ask-forge").replace("/index.js", "/tools.js")
);

const SYSTEM_PROMPT: string = askForgeConfig.SYSTEM_PROMPT;
const MODEL_PROVIDER: string = askForgeConfig.MODEL_PROVIDER;
const MODEL_NAME: string = askForgeConfig.MODEL_NAME;
const MAX_TOOL_ITERATIONS: number = askForgeConfig.MAX_TOOL_ITERATIONS;
const tools: Tool[] = askForgeTools.tools;

// Import Session class for creating sandbox sessions
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of internal module
const sessionModule: any = await import(
	import.meta.resolve("@nilenso/ask-forge").replace("/index.js", "/session.js")
);
const SessionClass: new (
	repo: SandboxRepo,
	config: {
		model: ReturnType<typeof getModel>;
		systemPrompt: string;
		tools: Tool[];
		maxIterations: number;
		executeTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<string>;
		stream: typeof stream;
	},
) => Session = sessionModule.Session;

/** Type for SandboxClient (matches ask-forge's implementation) */
interface SandboxClientType {
	health(): Promise<boolean>;
	waitForReady(maxWaitMs?: number): Promise<void>;
	clone(url: string, commitish?: string): Promise<{ slug: string; sha: string; worktree: string }>;
	executeTool(slug: string, sha: string, name: string, args: Record<string, unknown>): Promise<string>;
	reset(): Promise<void>;
}

/** Repo-like object for sandbox sessions */
interface SandboxRepo {
	url: string;
	localPath: string;
	commitish: string;
	cachePath: string;
	forge: { name: string };
	// Sandbox-specific fields
	_sandbox: {
		slug: string;
		sha: string;
		worktree: string;
	};
}

/** Sandbox configuration from environment */
export interface SandboxConfig {
	enabled: boolean;
	url: string;
	secret: string;
	timeoutMs: number;
}

/** Get sandbox configuration from environment */
export function getSandboxConfig(): SandboxConfig {
	const url = process.env.SANDBOX_URL || "";
	return {
		enabled: !!url,
		url,
		secret: process.env.SANDBOX_SECRET || "",
		timeoutMs: Number.parseInt(process.env.SANDBOX_TIMEOUT_MS || "120000", 10),
	};
}

/** Singleton sandbox client instance */
let sandboxClient: SandboxClientType | null = null;

/** Get or create the sandbox client */
export function getSandboxClient(): SandboxClientType | null {
	const config = getSandboxConfig();
	if (!config.enabled) return null;

	if (!sandboxClient) {
		sandboxClient = new SandboxClient({
			baseUrl: config.url,
			secret: config.secret,
			timeoutMs: config.timeoutMs,
		});
	}
	return sandboxClient;
}

/** Check if sandbox is healthy */
export async function checkSandboxHealth(): Promise<boolean> {
	const client = getSandboxClient();
	if (!client) return false;
	return client.health();
}

/** Wait for sandbox to be ready (with retries) */
export async function waitForSandbox(maxWaitMs = 30000): Promise<void> {
	const client = getSandboxClient();
	if (!client) {
		throw new Error("Sandbox not configured");
	}
	await client.waitForReady(maxWaitMs);
}

/**
 * Connect to a repository using sandbox isolation.
 *
 * Clones the repository inside the sandbox container and creates a Session
 * that delegates all tool execution to the sandbox.
 */
export async function connectWithSandbox(
	repoUrl: string,
	options: { commitish?: string } = {},
): Promise<Session> {
	const client = getSandboxClient();
	if (!client) {
		throw new Error("Sandbox not configured - set SANDBOX_URL environment variable");
	}

	// Clone the repository inside the sandbox
	const cloneResult = await client.clone(repoUrl, options.commitish);

	// Create a repo object that tracks sandbox state
	const repo: SandboxRepo = {
		url: repoUrl,
		localPath: cloneResult.worktree, // Path inside the container
		commitish: cloneResult.sha,
		cachePath: "", // Not used in sandbox mode
		forge: { name: "github" }, // Default, not really used
		_sandbox: {
			slug: cloneResult.slug,
			sha: cloneResult.sha,
			worktree: cloneResult.worktree,
		},
	};

	// Create tool executor that delegates to sandbox
	const executeTool = async (name: string, args: Record<string, unknown>, _cwd: string): Promise<string> => {
		return client.executeTool(repo._sandbox.slug, repo._sandbox.sha, name, args);
	};

	// Create the session with sandbox-aware tool execution
	// biome-ignore lint/suspicious/noExplicitAny: dynamic import loses type info, getModel generics are complex
	const model = getModel(MODEL_PROVIDER as any, MODEL_NAME as any);
	const session = new SessionClass(repo, {
		model,
		systemPrompt: SYSTEM_PROMPT,
		tools,
		maxIterations: MAX_TOOL_ITERATIONS,
		executeTool,
		stream,
	});

	return session;
}

/** Log sandbox status on startup */
export function logSandboxStatus(): void {
	const config = getSandboxConfig();
	if (config.enabled) {
		console.log(`🔒 Sandbox mode: ENABLED (${config.url})`);
	} else {
		console.log("🔓 Sandbox mode: DISABLED (local execution)");
	}
}
