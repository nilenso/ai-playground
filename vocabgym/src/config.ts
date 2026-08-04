import { loadSync } from "@std/dotenv";

export type AppConfig = {
	port: number;
	databasePath: string;
	publicBaseUrl: string;
	rpName: string;
	adminUsername: string;
	sessionCookieName: string;
	sessionTtlDays: number;
	openRouterApiKey?: string;
	openRouterBaseUrl: string;
};

export function loadConfig(env = loadEnv()): AppConfig {
	return {
		port: Number(env.PORT ?? "8000"),
		databasePath: env.DATABASE_PATH ?? "./data/vocabgym.sqlite",
		publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:8000",
		rpName: env.RP_NAME ?? "VocabGym",
		adminUsername: env.ADMIN_USERNAME ?? "admin",
		sessionCookieName: env.SESSION_COOKIE_NAME ?? "vocabgym_session",
		sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? "30"),
		openRouterApiKey: env.OPENROUTER_API_KEY,
		openRouterBaseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
	};
}

function loadEnv(): Record<string, string> {
	const processEnv = Deno.env.toObject();
	try {
		const fileEnv = loadSync({ envPath: ".env", export: false });
		return { ...fileEnv, ...processEnv };
	} catch {
		return processEnv;
	}
}

export function getRpId(config: AppConfig): string {
	return new URL(config.publicBaseUrl).hostname;
}

export function isSecureCookie(config: AppConfig): boolean {
	return new URL(config.publicBaseUrl).protocol === "https:";
}
