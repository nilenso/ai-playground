/**
 * Bot — the kernel that owns services and orchestrates plugins.
 *
 * Usage:
 *   const bot = new Bot({ ai, calendar, harvest, slack });
 *   bot.register(myPlugin);
 *   await bot.start();
 */

import type { PluginConfig } from "./config/plugin-config.js";
import { resolvePluginConfig } from "./config/plugin-config.js";
import type { BotContext, Plugin } from "./interfaces/plugin.js";
import { logger } from "./logger.js";

export interface BotOptions {
	/**
	 * Optional dictionary of plugin configurations.
     * Can optionally use a `pluginInstanceId` if multiple instances of the same plugin exist.
	 */
	pluginConfigs?: Record<string, Record<string, any>>;
}

export interface RegisteredPlugin {
    plugin: Plugin;
    instanceId?: string;
}

export class Bot {
	private readonly ctx: BotContext;
	private readonly pluginConfigs: Record<string, Record<string, any>>;
	private readonly plugins: RegisteredPlugin[] = [];
	private running = false;

	constructor(services: BotContext, options?: BotOptions) {
		this.ctx = services;
		this.pluginConfigs = options?.pluginConfigs ?? {};
	}

	/**
	 * Register a plugin. Can optionally pass an instanceId.
	 * Must be called before start().
	 */
	register(plugin: Plugin, instanceId?: string): this {
		if (this.running) {
			throw new Error(`Cannot register plugin "${plugin.name}" after bot has started`);
		}
		this.plugins.push({ plugin, instanceId });
		return this;
	}

	/**
	 * Initialize all plugins, then start the Slack service.
	 *
	 * For each plugin with a `configSchema`, local configs are resolved and validated
	 * before calling `init()`. Missing required config causes a fast failure.
	 */
	async start(): Promise<void> {
		if (this.running) return;

		// Init plugins in registration order
		for (const { plugin, instanceId } of this.plugins) {
			const config = this.resolveConfig(plugin, instanceId);
			logger.info("initializing plugin", { plugin: plugin.name, instanceId });
			await plugin.init(this.ctx, config);
		}

		await this.ctx.slack.start();
		this.running = true;
		logger.info("bot started", { pluginCount: this.plugins.length });
	}

	/**
	 * Stop Slack, then tear down plugins in reverse order.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;

		await this.ctx.slack.stop();

		// Stop plugins in reverse order
		for (const { plugin, instanceId } of [...this.plugins].reverse()) {
			if (plugin.stop) {
				logger.info("stopping plugin", { plugin: plugin.name, instanceId });
				await plugin.stop();
			}
		}

		this.running = false;
		logger.info("bot stopped");
	}

	get isRunning(): boolean {
		return this.running;
	}

	get registeredPlugins(): readonly Plugin[] {
		return this.plugins.map(p => p.plugin);
	}

	private resolveConfig(plugin: Plugin, instanceId?: string): PluginConfig {
		if (!plugin.configSchema) return {};
        const configKey = instanceId ? `${plugin.name}_${instanceId}` : plugin.name;
		const localConfig = this.pluginConfigs[configKey] || {};
		return resolvePluginConfig(plugin.name, plugin.configSchema, localConfig);
	}
}
