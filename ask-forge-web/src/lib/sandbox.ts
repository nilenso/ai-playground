/**
 * Sandbox configuration for ask-forge-web.
 *
 * When SANDBOX_URL is set, tool execution is delegated to an isolated container
 * instead of running locally. This provides security isolation for untrusted code.
 *
 * The actual sandbox integration is handled by AskForgeClient when sandbox config is provided.
 */

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

/** Check if sandbox is healthy */
export async function checkSandboxHealth(): Promise<boolean> {
	const config = getSandboxConfig();
	if (!config.enabled) return false;

	try {
		const response = await fetch(`${config.url}/health`, {
			headers: config.secret ? { Authorization: `Bearer ${config.secret}` } : {},
		});
		return response.ok;
	} catch {
		return false;
	}
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
