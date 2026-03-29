/**
 * Plugin interface.
 *
 * A plugin is a self-contained unit of bot functionality. It receives
 * a BotContext with access to all services, registers its message handlers
 * during init(), and cleans up during stop().
 *
 * Plugins don't know about each other — the Bot orchestrates them.
 */

import type { PluginConfig, PluginConfigSchema } from "../config/plugin-config.js";
import type { AIService } from "./ai.js";
import type { CalendarService } from "./calendar.js";
import type { HarvestService } from "./harvest.js";
import type { SlackService } from "./slack.js";

/**
 * Services available to every plugin.
 * Plugins take what they need; they don't have to use everything.
 */
export interface BotContext {
	readonly ai: AIService;
	readonly calendar: CalendarService;
	readonly harvest: HarvestService;
	readonly slack: SlackService;
}

export interface Plugin {
	/** Unique name for logging and debugging */
	readonly name: string;

	/**
	 * Optional config schema. When present, the Bot resolves env vars at start
	 * time and passes the result to `init()`. Missing required fields cause
	 * the bot to fail fast with a clear error.
	 *
	 * @example
	 * configSchema: {
	 *   channelId: { envVar: "SLACK_CHANNEL_ID", description: "Channel to listen in" },
	 *   keywords:  { envVar: "TRIGGER_KEYWORDS", default: "leave,vacation,sick" },
	 * }
	 */
	readonly configSchema?: PluginConfigSchema;

	/**
	 * Called once when the bot starts. Register message handlers,
	 * set up state, etc.
	 *
	 * @param ctx — services (AI, Calendar, Harvest, Slack)
	 * @param config — resolved plugin config (empty object if no configSchema)
	 */
	init(ctx: BotContext, config: PluginConfig): Promise<void> | void;

	/**
	 * Called when the bot shuts down. Clean up resources.
	 * Optional — not every plugin needs teardown.
	 */
	stop?(): Promise<void> | void;
}
