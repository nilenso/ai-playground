/**
 * 12-factor style configuration.
 * All config is read from environment variables (loaded from .env by Bun automatically).
 * Each integration reads only what it needs; missing optional values are undefined.
 */

export interface SlackConfig {
	botToken: string;
	signingSecret: string;
	appToken: string; // for socket mode
	port?: number;
}

export interface AIConfig {
	provider: string; // e.g. "anthropic", "openai", "google"
	model: string; // e.g. "claude-sonnet-4-20250514"
	apiKey: string;
	maxTokens?: number;
	temperature?: number;
}

export interface GoogleCalendarConfig {
	clientEmail: string;
	privateKey: string;
	calendarId: string;
}

export interface HarvestConfig {
	accessToken: string;
	accountId: string;
	projectId: number;
	vacationTaskId: number;
	sickTaskId: number;
}

export interface AppConfig {
	slack: SlackConfig;
	ai: AIConfig;
	gcal: GoogleCalendarConfig;
	harvest: HarvestConfig;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function optional(name: string): string | undefined {
	return process.env[name];
}

function optionalInt(name: string): number | undefined {
	const v = optional(name);
	return v ? Number.parseInt(v, 10) : undefined;
}

function requiredInt(name: string): number {
	const v = required(name);
	const n = Number.parseInt(v, 10);
	if (Number.isNaN(n)) {
		throw new Error(`Environment variable ${name} must be an integer, got: ${v}`);
	}
	return n;
}

function optionalFloat(name: string): number | undefined {
	const v = optional(name);
	return v ? Number.parseFloat(v) : undefined;
}

export function loadSlackConfig(): SlackConfig {
	return {
		botToken: required("SLACK_BOT_TOKEN"),
		signingSecret: required("SLACK_SIGNING_SECRET"),
		appToken: required("SLACK_APP_TOKEN"),
		port: optionalInt("SLACK_PORT"),
	};
}

export function loadAIConfig(): AIConfig {
	return {
		provider: required("AI_PROVIDER"),
		model: required("AI_MODEL"),
		apiKey: required("AI_API_KEY"),
		maxTokens: optionalInt("AI_MAX_TOKENS"),
		temperature: optionalFloat("AI_TEMPERATURE"),
	};
}

/**
 * Load Google Calendar config.
 *
 * Supports two auth formats (checked in order):
 *
 * 1. **Base64 JSON blob** — `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` contains the
 *    entire GCP service-account JSON file, base64-encoded. One env var,
 *    copy-paste from the GCP console download. `client_email` and
 *    `private_key` are extracted automatically.
 *
 * 2. **Individual fields** — `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`
 *    (the original approach). More explicit, useful when you don't have the
 *    full JSON file handy.
 *
 * `GOOGLE_CALENDAR_ID` is always required.
 */
export function loadGoogleCalendarConfig(): GoogleCalendarConfig {
	const calendarId = required("GOOGLE_CALENDAR_ID");

	const base64Json = optional("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
	if (base64Json) {
		return parseServiceAccountJson(base64Json, calendarId);
	}

	return {
		clientEmail: required("GOOGLE_CLIENT_EMAIL"),
		privateKey: required("GOOGLE_PRIVATE_KEY"),
		calendarId,
	};
}

/**
 * Decode a base64-encoded GCP service account JSON and extract the fields
 * needed for Calendar auth.
 */
export function parseServiceAccountJson(base64: string, calendarId: string): GoogleCalendarConfig {
	let decoded: string;
	try {
		decoded = atob(base64);
	} catch {
		throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64");
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(decoded);
	} catch {
		throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 does not contain valid JSON");
	}

	const clientEmail = json.client_email;
	if (typeof clientEmail !== "string" || !clientEmail) {
		throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 JSON is missing "client_email"');
	}

	const privateKey = json.private_key;
	if (typeof privateKey !== "string" || !privateKey) {
		throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 JSON is missing "private_key"');
	}

	return { clientEmail, privateKey, calendarId };
}

export function loadHarvestConfig(): HarvestConfig {
	return {
		accessToken: required("HARVEST_ACCESS_TOKEN"),
		accountId: required("HARVEST_ACCOUNT_ID"),
		projectId: requiredInt("HARVEST_PROJECT_ID"),
		vacationTaskId: requiredInt("HARVEST_VACATION_TASK_ID"),
		sickTaskId: requiredInt("HARVEST_SICK_TASK_ID"),
	};
}

export function loadConfig(): AppConfig {
	return {
		slack: loadSlackConfig(),
		ai: loadAIConfig(),
		gcal: loadGoogleCalendarConfig(),
		harvest: loadHarvestConfig(),
	};
}

export type { PluginConfig, PluginConfigField, PluginConfigSchema } from "./plugin-config.js";
export { resolvePluginConfig } from "./plugin-config.js";
