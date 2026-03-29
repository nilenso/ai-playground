/**
 * Helpers for integration tests.
 *
 * Integration tests hit real APIs and require real credentials.
 * They skip gracefully when env vars are missing.
 */

import { beforeAll, describe, expect, it } from "bun:test";

export { describe, expect, it };

/**
 * Conditionally run a describe block only when all required env vars are set.
 * If any are missing, the suite is skipped with a clear reason.
 *
 * The env var check happens at beforeAll time (not module-load time)
 * so it doesn't race with other test files that mutate process.env.
 *
 * The callback receives a getter function that returns the env vars.
 * Call it inside `it()` blocks, not at describe scope.
 */
export function describeIntegration(
	name: string,
	requiredVars: string[],
	fn: (getEnv: () => Record<string, string>) => void,
): void {
	describe(name, () => {
		let envVars: Record<string, string> | null = null;
		let skipReason: string | null = null;

		beforeAll(() => {
			const missing = requiredVars.filter((v) => !process.env[v]);
			if (missing.length > 0) {
				skipReason = `Missing env vars: ${missing.join(", ")}`;
			} else {
				envVars = {};
				for (const v of requiredVars) {
					envVars[v] = process.env[v] as string;
				}
			}
		});

		const getEnv = (): Record<string, string> => {
			if (skipReason) {
				throw new Error(`Skipped: ${skipReason}`);
			}
			return envVars as Record<string, string>;
		};

		fn(getEnv);
	});
}
