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
	/** Human-readable description (for docs / error messages). */
	description?: string;
	/** Whether this field is required. Default: true. */
	required?: boolean;
	/** Default value when the config is unset. Implies required=false. */
	default?: string | number | boolean;
}

/**
 * A plugin's config schema. Keys are the logical config names the plugin uses.
 *
 * @example
 * const schema: PluginConfigSchema = {
 *   channelId:       { description: "Channel to listen in" },
 *   triggerKeywords: { default: "leave,vacation,sick" },
 *   defaultTimezone: { default: "Asia/Kolkata" },
 *   expiryMinutes:   { default: 30 },
 * };
 */
export type PluginConfigSchema = Record<string, PluginConfigField>;

/**
 * Resolved config values — the result of resolving a schema against a local config.
 */
export type PluginConfig = Record<string, any>;

/**
 * Resolve a plugin config schema against a local dictionary (from TOML).
 *
 * @param pluginName — used in error messages
 * @param schema — the plugin's declared config schema
 * @param localConfig — local dictionary (from TOML)
 * @returns resolved config values
 * @throws if any required field is missing
 */
export function resolvePluginConfig(
	pluginName: string,
	schema: PluginConfigSchema,
	localConfig: Record<string, any> = {},
): PluginConfig {
	const config: PluginConfig = {};
	const missing: string[] = [];

	for (const [key, field] of Object.entries(schema)) {
		const value = localConfig[key];

		if (value !== undefined && value !== "") {
			config[key] = value;
		} else if (field.default !== undefined) {
			config[key] = field.default;
		} else {
			const isRequired = field.required !== false && field.default === undefined;
			if (isRequired) {
				const desc = field.description ? ` (${field.description})` : "";
				missing.push(`${key}${desc}`);
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
