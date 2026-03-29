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

export interface BotOptions {
	/**
	 * Environment source for resolving plugin config.
	 * Defaults to `process.env`. Override in tests to avoid touching real env vars.
	 */
	env?: Record<string, string | undefined>;
}

export class Bot {
	private readonly ctx: BotContext;
	private readonly env: Record<string, string | undefined>;
	private readonly plugins: Plugin[] = [];
	private running = false;

	constructor(services: BotContext, options?: BotOptions) {
		this.ctx = services;
		this.env = options?.env ?? process.env;
	}

	/**
	 * Register a plugin. Must be called before start().
	 */
	register(plugin: Plugin): this {
		if (this.running) {
			throw new Error(`Cannot register plugin "${plugin.name}" after bot has started`);
		}
		this.plugins.push(plugin);
		return this;
	}

	/**
	 * Initialize all plugins, then start the Slack service.
	 *
	 * For each plugin with a `configSchema`, env vars are resolved and validated
	 * before calling `init()`. Missing required config causes a fast failure.
	 */
	async start(): Promise<void> {
		if (this.running) return;

		// Init plugins in registration order
		for (const plugin of this.plugins) {
			const config = this.resolveConfig(plugin);
			console.log(`[bot] initializing plugin: ${plugin.name}`);
			await plugin.init(this.ctx, config);
		}

		await this.ctx.slack.start();
		this.running = true;
		console.log(`[bot] started with ${this.plugins.length} plugin(s)`);
	}

	/**
	 * Stop Slack, then tear down plugins in reverse order.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;

		await this.ctx.slack.stop();

		// Stop plugins in reverse order
		for (const plugin of [...this.plugins].reverse()) {
			if (plugin.stop) {
				console.log(`[bot] stopping plugin: ${plugin.name}`);
				await plugin.stop();
			}
		}

		this.running = false;
		console.log("[bot] stopped");
	}

	get isRunning(): boolean {
		return this.running;
	}

	get registeredPlugins(): readonly Plugin[] {
		return this.plugins;
	}

	private resolveConfig(plugin: Plugin): PluginConfig {
		if (!plugin.configSchema) return {};
		return resolvePluginConfig(plugin.name, plugin.configSchema, this.env);
	}
}
