/**
 * Configuration loader.
 *
 * Reads from a TOML config file (default: `config.toml`, override via `CONFIG_PATH` env var).
 * Falls back to environment variables when no TOML file is found.
 *
 * TOML structure mirrors the typed interfaces:
 *
 *   [slack]
 *   bot_token = "xoxb-..."
 *   signing_secret = "..."
 *   app_token = "xapp-..."
 *   port = 3000          # optional
 *
 *   [ai]
 *   provider = "anthropic"
 *   model = "claude-sonnet-4-20250514"
 *   api_key = "sk-..."
 *   max_tokens = 4096    # optional
 *   temperature = 0.7    # optional
 *
 *   [google_calendar]
 *   service_account_json_base64 = "eyJ0..."   # option 1
 *   # — or —
 *   client_email = "bot@..."                   # option 2
 *   private_key = "-----BEGIN..."              # option 2
 *   calendar_id = "...@group.calendar.google.com"
 *
 *   [harvest]
 *   access_token = "..."
 *   account_id = "318270"
 *   project_id = "39766381"
 *   vacation_task_id = "21993693"
 *   sick_task_id = "2286530"
 *
 *   # Plugin env vars — seeded into process.env so plugins pick them up
 *   [env]
 *   SLACK_LEAVE_CHANNEL_ID = "CMVPEEWCQ"
 *   TRIGGER_KEYWORDS = "leave,ooo,wfh,sick,vacation,pto,day off"
 */

import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";

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

// ── TOML loading ────────────────────────────────────

type TomlData = Record<string, Record<string, unknown>>;

let _toml: TomlData | null | undefined; // undefined = not yet attempted

/**
 * Load and cache the TOML config file.
 * Returns null when no file is found (falls back to env vars).
 */
function loadToml(): TomlData | null {
	if (_toml !== undefined) return _toml;

	const configPath = process.env.CONFIG_PATH ?? "config.toml";
	if (!existsSync(configPath)) {
		_toml = null;
		return null;
	}

	const raw = readFileSync(configPath, "utf-8");
	_toml = parse(raw) as TomlData;

	// Seed process.env from [env] section so plugin configs (which read
	// process.env directly) can be driven from the TOML file too.
	if (_toml.env) {
		for (const [key, val] of Object.entries(_toml.env)) {
			if (val !== undefined && val !== null && val !== "" && !process.env[key]) {
				process.env[key] = String(val);
			}
		}
	}

	return _toml;
}

/** Reset cached TOML (for testing). */
export function _resetTomlCache(): void {
	_toml = undefined;
}

// ── Value accessors (TOML-first, env-var fallback) ──

function tomlGet(section: string, key: string): string | undefined {
	const toml = loadToml();
	if (toml?.[section]) {
		const val = toml[section][key];
		if (val !== undefined && val !== null && val !== "") return String(val);
	}
	return undefined;
}

function required(section: string, key: string, envName: string): string {
	const value = tomlGet(section, key) ?? process.env[envName];
	if (!value) {
		const source = loadToml() ? `[${section}] ${key}` : envName;
		throw new Error(`Missing required config: ${source}`);
	}
	return value;
}

function optional(section: string, key: string, envName: string): string | undefined {
	return tomlGet(section, key) ?? process.env[envName];
}

function optionalInt(section: string, key: string, envName: string): number | undefined {
	const v = optional(section, key, envName);
	return v ? Number.parseInt(v, 10) : undefined;
}

function requiredInt(section: string, key: string, envName: string): number {
	const v = required(section, key, envName);
	const n = Number.parseInt(v, 10);
	if (Number.isNaN(n)) {
		const source = loadToml() ? `[${section}] ${key}` : envName;
		throw new Error(`Config ${source} must be an integer, got: ${v}`);
	}
	return n;
}

function optionalFloat(section: string, key: string, envName: string): number | undefined {
	const v = optional(section, key, envName);
	return v ? Number.parseFloat(v) : undefined;
}

// ── Section loaders ─────────────────────────────────

export function loadSlackConfig(): SlackConfig {
	return {
		botToken: required("slack", "bot_token", "SLACK_BOT_TOKEN"),
		signingSecret: required("slack", "signing_secret", "SLACK_SIGNING_SECRET"),
		appToken: required("slack", "app_token", "SLACK_APP_TOKEN"),
		port: optionalInt("slack", "port", "SLACK_PORT"),
	};
}

export function loadAIConfig(): AIConfig {
	return {
		provider: required("ai", "provider", "AI_PROVIDER"),
		model: required("ai", "model", "AI_MODEL"),
		apiKey: required("ai", "api_key", "AI_API_KEY"),
		maxTokens: optionalInt("ai", "max_tokens", "AI_MAX_TOKENS"),
		temperature: optionalFloat("ai", "temperature", "AI_TEMPERATURE"),
	};
}

/**
 * Load Google Calendar config.
 *
 * Supports two auth formats (checked in order):
 *
 * 1. **Base64 JSON blob** — `service_account_json_base64` (TOML) or
 *    `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (env). One value containing the
 *    entire GCP service-account JSON file, base64-encoded.
 *
 * 2. **Individual fields** — `client_email` + `private_key` (TOML) or
 *    `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` (env).
 *
 * `calendar_id` / `GOOGLE_CALENDAR_ID` is always required.
 */
export function loadGoogleCalendarConfig(): GoogleCalendarConfig {
	const calendarId = required("google_calendar", "calendar_id", "GOOGLE_CALENDAR_ID");

	const base64Json = optional("google_calendar", "service_account_json_base64", "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
	if (base64Json) {
		return parseServiceAccountJson(base64Json, calendarId);
	}

	return {
		clientEmail: required("google_calendar", "client_email", "GOOGLE_CLIENT_EMAIL"),
		privateKey: required("google_calendar", "private_key", "GOOGLE_PRIVATE_KEY"),
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
		throw new Error("service_account_json_base64 is not valid base64");
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(decoded);
	} catch {
		throw new Error("service_account_json_base64 does not contain valid JSON");
	}

	const clientEmail = json.client_email;
	if (typeof clientEmail !== "string" || !clientEmail) {
		throw new Error('service_account_json_base64 JSON is missing "client_email"');
	}

	const privateKey = json.private_key;
	if (typeof privateKey !== "string" || !privateKey) {
		throw new Error('service_account_json_base64 JSON is missing "private_key"');
	}

	return { clientEmail, privateKey, calendarId };
}

export function loadHarvestConfig(): HarvestConfig {
	return {
		accessToken: required("harvest", "access_token", "HARVEST_ACCESS_TOKEN"),
		accountId: required("harvest", "account_id", "HARVEST_ACCOUNT_ID"),
		projectId: requiredInt("harvest", "project_id", "HARVEST_PROJECT_ID"),
		vacationTaskId: requiredInt("harvest", "vacation_task_id", "HARVEST_VACATION_TASK_ID"),
		sickTaskId: requiredInt("harvest", "sick_task_id", "HARVEST_SICK_TASK_ID"),
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
