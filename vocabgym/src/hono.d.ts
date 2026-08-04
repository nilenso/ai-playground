import type { AuthState } from "./auth/sessions.ts";

declare module "hono" {
	interface ContextVariableMap {
		auth: AuthState;
	}
}

export {};
