import { parse } from "smol-toml";
import * as fs from "fs";

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
}

export interface PluginDefinition {
    name: string;
    config?: Record<string, any>;
}

export interface AppConfig {
	app?: { port?: number };
	slack: SlackConfig;
	ai: AIConfig;
	gcal: GoogleCalendarConfig;
	harvest: HarvestConfig;
    plugins?: PluginDefinition[];
}

function required<T>(obj: Record<string, any> | undefined, section: string, key: string): T {
	if (!obj || obj[key] === undefined || obj[key] === null || obj[key] === "") {
		throw new Error(`Missing required config [${section}] ${key}`);
	}
	return obj[key] as T;
}

function optional<T>(obj: Record<string, any> | undefined, key: string): T | undefined {
	return obj && obj[key] !== undefined && obj[key] !== "" ? (obj[key] as T) : undefined;
}

function optionalInt(obj: Record<string, any> | undefined, key: string): number | undefined {
	const v = optional<any>(obj, key);
    if (v === undefined) return undefined;
    if (typeof v === "number") return v;
	return Number.parseInt(String(v), 10);
}

function requiredInt(obj: Record<string, any> | undefined, section: string, key: string): number {
	const v = required<any>(obj, section, key);
    if (typeof v === "number") return v;
	const n = Number.parseInt(String(v), 10);
	if (Number.isNaN(n)) {
		throw new Error(`Config [${section}] ${key} must be an integer, got: ${v}`);
	}
	return n;
}

function optionalFloat(obj: Record<string, any> | undefined, key: string): number | undefined {
	const v = optional<any>(obj, key);
    if (v === undefined) return undefined;
    if (typeof v === "number") return v;
	return Number.parseFloat(String(v));
}

export function loadSlackConfig(raw: Record<string, any>): SlackConfig {
    const section = raw.slack;
	return {
		botToken: required(section, "slack", "botToken"),
		signingSecret: required(section, "slack", "signingSecret"),
		appToken: required(section, "slack", "appToken"),
		port: optionalInt(section, "port"),
	};
}

export function loadAIConfig(raw: Record<string, any>): AIConfig {
    const section = raw.ai;
	return {
		provider: required(section, "ai", "provider"),
		model: required(section, "ai", "model"),
		apiKey: required(section, "ai", "apiKey"),
		maxTokens: optionalInt(section, "maxTokens"),
		temperature: optionalFloat(section, "temperature"),
	};
}

export function loadGoogleCalendarConfig(raw: Record<string, any>): GoogleCalendarConfig {
    const section = raw.gcal;
	const calendarId = required<string>(section, "gcal", "calendarId");

	const base64Json = optional<string>(section, "serviceAccountJsonBase64");
	if (base64Json) {
		return parseServiceAccountJson(base64Json, calendarId);
	}

	return {
		clientEmail: required(section, "gcal", "clientEmail"),
		privateKey: required(section, "gcal", "privateKey"),
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
		throw new Error("serviceAccountJsonBase64 is not valid base64");
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(decoded);
	} catch {
		throw new Error("serviceAccountJsonBase64 does not contain valid JSON");
	}

	const clientEmail = json.client_email;
	if (typeof clientEmail !== "string" || !clientEmail) {
		throw new Error('serviceAccountJsonBase64 JSON is missing "client_email"');
	}

	const privateKey = json.private_key;
	if (typeof privateKey !== "string" || !privateKey) {
		throw new Error('serviceAccountJsonBase64 JSON is missing "private_key"');
	}

	return { clientEmail, privateKey, calendarId };
}

export function loadHarvestConfig(raw: Record<string, any>): HarvestConfig {
    const section = raw.harvest;
	return {
		accessToken: required(section, "harvest", "accessToken"),
		accountId: required(section, "harvest", "accountId"),
	};
}

export function loadConfig(configPath: string = "jadoo.toml"): AppConfig {
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    const tomlString = fs.readFileSync(configPath, "utf-8");
    const raw = parse(tomlString);

	return {
        app: raw.app,
		slack: loadSlackConfig(raw),
		ai: loadAIConfig(raw),
		gcal: loadGoogleCalendarConfig(raw),
		harvest: loadHarvestConfig(raw),
        plugins: raw.plugins,
	};
}

export type { PluginConfig, PluginConfigField, PluginConfigSchema } from "./plugin-config.js";
export { resolvePluginConfig } from "./plugin-config.js";
