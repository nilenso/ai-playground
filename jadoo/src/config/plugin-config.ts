/**
 * Plugin-scoped configuration.
 *
 * Plugins declare a `configSchema` describing the env vars they need.
 * The Bot resolves and validates the schema at start time, then passes
 * the result to the plugin's `init()`.
 *
 * This keeps plugins self-documenting, fail-fast, and testable (tests
 * pass a plain object instead of manipulating `process.env`).
 */

/**
 * Describes a single config field a plugin needs.
 */
export interface PluginConfigField {
	/** Environment variable name to read from. */
	envVar: string;
	/** Human-readable description (for docs / error messages). */
	description?: string;
	/** Whether this field is required. Default: true. */
	required?: boolean;
	/** Default value when the env var is unset. Implies required=false. */
	default?: string;
}

/**
 * A plugin's config schema. Keys are the logical config names the plugin
 * uses internally; values describe how to resolve them from the environment.
 *
 * @example
 * const schema: PluginConfigSchema = {
 *   channelId:      { envVar: "SLACK_CHANNEL_ID", description: "Channel to listen in" },
 *   triggerKeywords: { envVar: "TRIGGER_KEYWORDS", default: "leave,vacation,sick" },
 *   defaultTimezone: { envVar: "DEFAULT_TIMEZONE", default: "Asia/Kolkata" },
 *   expiryMinutes:   { envVar: "PENDING_ACTION_EXPIRY_MINUTES", default: "30" },
 * };
 */
export type PluginConfigSchema = Record<string, PluginConfigField>;

/**
 * Resolved config values — the result of resolving a schema against an env source.
 * Keys match the schema keys. Values are always strings (or undefined for
 * optional fields that had no default and no env var set).
 */
export type PluginConfig = Record<string, string | undefined>;

/**
 * Resolve a plugin config schema against an environment source.
 *
 * @param pluginName — used in error messages
 * @param schema — the plugin's declared config schema
 * @param env — environment source (defaults to `process.env`)
 * @returns resolved config values
 * @throws if any required field is missing
 */
export function resolvePluginConfig(
	pluginName: string,
	schema: PluginConfigSchema,
	env: Record<string, string | undefined> = process.env,
): PluginConfig {
	const config: PluginConfig = {};
	const missing: string[] = [];

	for (const [key, field] of Object.entries(schema)) {
		const value = env[field.envVar];

		if (value !== undefined && value !== "") {
			config[key] = value;
		} else if (field.default !== undefined) {
			config[key] = field.default;
		} else {
			const isRequired = field.required !== false && field.default === undefined;
			if (isRequired) {
				const desc = field.description ? ` (${field.description})` : "";
				missing.push(`${field.envVar}${desc}`);
			}
			// optional with no default → undefined
			config[key] = undefined;
		}
	}

	if (missing.length > 0) {
		throw new Error(`Plugin "${pluginName}" is missing required config:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
	}

	return config;
}
