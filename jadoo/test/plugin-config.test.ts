import { describe, expect, it } from "bun:test";
import { Bot } from "../src/bot.js";
import type { PluginConfig, PluginConfigSchema } from "../src/config/plugin-config.js";
import { resolvePluginConfig } from "../src/config/plugin-config.js";
import type { Plugin } from "../src/interfaces/plugin.js";
import { MockAIService, MockCalendarService, MockHarvestService, MockSlackService } from "./mocks.js";

function createServices() {
	return {
		ai: new MockAIService(),
		calendar: new MockCalendarService(),
		harvest: new MockHarvestService(),
		slack: new MockSlackService(),
	};
}

// ─── resolvePluginConfig ────────────────────────────────

describe("resolvePluginConfig", () => {
	it("resolves env vars by schema keys", () => {
		const schema: PluginConfigSchema = {
			channelId: { envVar: "SLACK_CHANNEL_ID" },
			keywords: { envVar: "TRIGGER_KEYWORDS" },
		};
		const env = { SLACK_CHANNEL_ID: "C123", TRIGGER_KEYWORDS: "leave,pto" };

		const config = resolvePluginConfig("test", schema, env);
		expect(config.channelId).toBe("C123");
		expect(config.keywords).toBe("leave,pto");
	});

	it("applies default values when env var is unset", () => {
		const schema: PluginConfigSchema = {
			timezone: { envVar: "DEFAULT_TIMEZONE", default: "Asia/Kolkata" },
			expiry: { envVar: "EXPIRY_MINUTES", default: "30" },
		};

		const config = resolvePluginConfig("test", schema, {});
		expect(config.timezone).toBe("Asia/Kolkata");
		expect(config.expiry).toBe("30");
	});

	it("env var overrides default", () => {
		const schema: PluginConfigSchema = {
			timezone: { envVar: "DEFAULT_TIMEZONE", default: "Asia/Kolkata" },
		};
		const env = { DEFAULT_TIMEZONE: "America/New_York" };

		const config = resolvePluginConfig("test", schema, env);
		expect(config.timezone).toBe("America/New_York");
	});

	it("throws on missing required field", () => {
		const schema: PluginConfigSchema = {
			channelId: { envVar: "SLACK_CHANNEL_ID", description: "Channel to listen in" },
		};

		expect(() => resolvePluginConfig("leave", schema, {})).toThrow('Plugin "leave" is missing required config');
	});

	it("error message includes env var name and description", () => {
		const schema: PluginConfigSchema = {
			channelId: { envVar: "SLACK_CHANNEL_ID", description: "Channel to listen in" },
		};

		try {
			resolvePluginConfig("leave", schema, {});
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("SLACK_CHANNEL_ID");
			expect(msg).toContain("Channel to listen in");
		}
	});

	it("collects all missing required fields in one error", () => {
		const schema: PluginConfigSchema = {
			a: { envVar: "VAR_A" },
			b: { envVar: "VAR_B" },
			c: { envVar: "VAR_C", default: "has-default" },
		};

		try {
			resolvePluginConfig("multi", schema, {});
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("VAR_A");
			expect(msg).toContain("VAR_B");
			expect(msg).not.toContain("VAR_C"); // has default, not missing
		}
	});

	it("explicitly optional fields are undefined when unset", () => {
		const schema: PluginConfigSchema = {
			reason: { envVar: "REASON", required: false },
		};

		const config = resolvePluginConfig("test", schema, {});
		expect(config.reason).toBeUndefined();
	});

	it("treats empty string as unset", () => {
		const schema: PluginConfigSchema = {
			channelId: { envVar: "SLACK_CHANNEL_ID", default: "fallback" },
		};

		const config = resolvePluginConfig("test", schema, { SLACK_CHANNEL_ID: "" });
		expect(config.channelId).toBe("fallback");
	});

	it("returns empty object for empty schema", () => {
		const config = resolvePluginConfig("test", {}, {});
		expect(config).toEqual({});
	});

	it("field with default is not required even without explicit required: false", () => {
		const schema: PluginConfigSchema = {
			tz: { envVar: "TZ", default: "UTC" },
		};

		// Should not throw
		const config = resolvePluginConfig("test", schema, {});
		expect(config.tz).toBe("UTC");
	});
});

// ─── Bot integration ────────────────────────────────────

describe("Bot resolves plugin config", () => {
	it("passes resolved config to plugin init", async () => {
		const services = createServices();
		let receivedConfig: PluginConfig = {};

		const plugin: Plugin = {
			name: "leave",
			configSchema: {
				channelId: { envVar: "SLACK_CHANNEL_ID" },
				keywords: { envVar: "TRIGGER_KEYWORDS", default: "leave,pto" },
			},
			init(_ctx, config) {
				receivedConfig = config;
			},
		};

		const bot = new Bot(services, {
			env: { SLACK_CHANNEL_ID: "C_LEAVE" },
		});
		bot.register(plugin);
		await bot.start();

		expect(receivedConfig.channelId).toBe("C_LEAVE");
		expect(receivedConfig.keywords).toBe("leave,pto");
		await bot.stop();
	});

	it("passes empty config when plugin has no configSchema", async () => {
		const services = createServices();
		let receivedConfig: PluginConfig | undefined;

		const plugin: Plugin = {
			name: "simple",
			init(_ctx, config) {
				receivedConfig = config;
			},
		};

		const bot = new Bot(services);
		bot.register(plugin);
		await bot.start();

		expect(receivedConfig).toEqual({});
		await bot.stop();
	});

	it("fails fast when required config is missing", async () => {
		const services = createServices();

		const plugin: Plugin = {
			name: "needs-config",
			configSchema: {
				channelId: { envVar: "SLACK_CHANNEL_ID", description: "Required channel" },
			},
			init() {},
		};

		const bot = new Bot(services, { env: {} });
		bot.register(plugin);

		await expect(bot.start()).rejects.toThrow("SLACK_CHANNEL_ID");
	});

	it("each plugin gets its own resolved config", async () => {
		const services = createServices();
		const configs: Record<string, PluginConfig> = {};

		const pluginA: Plugin = {
			name: "alpha",
			configSchema: {
				channel: { envVar: "ALPHA_CHANNEL" },
			},
			init(_ctx, config) {
				configs.alpha = config;
			},
		};

		const pluginB: Plugin = {
			name: "beta",
			configSchema: {
				channel: { envVar: "BETA_CHANNEL" },
				extra: { envVar: "BETA_EXTRA", default: "default-val" },
			},
			init(_ctx, config) {
				configs.beta = config;
			},
		};

		const bot = new Bot(services, {
			env: { ALPHA_CHANNEL: "C_A", BETA_CHANNEL: "C_B" },
		});
		bot.register(pluginA).register(pluginB);
		await bot.start();

		expect(configs.alpha).toEqual({ channel: "C_A" });
		expect(configs.beta).toEqual({ channel: "C_B", extra: "default-val" });
		await bot.stop();
	});

	it("plugin can use config in message handlers", async () => {
		const services = createServices();

		const plugin: Plugin = {
			name: "channel-filter",
			configSchema: {
				channelId: { envVar: "LISTEN_CHANNEL" },
			},
			init(ctx, config) {
				const targetChannel = config.channelId ?? "";
				ctx.slack.onMessage(async (msg) => {
					if (msg.channelId !== targetChannel) return null;
					return "heard you!";
				});
			},
		};

		const bot = new Bot(services, { env: { LISTEN_CHANNEL: "C_LEAVE" } });
		bot.register(plugin);
		await bot.start();

		// Message in the right channel
		const replies1 = await services.slack.simulateMessage({
			text: "hello",
			userId: "U1",
			channelId: "C_LEAVE",
			ts: "t1",
		});
		expect(replies1).toEqual(["heard you!"]);

		// Message in a different channel — ignored
		const replies2 = await services.slack.simulateMessage({
			text: "hello",
			userId: "U1",
			channelId: "C_OTHER",
			ts: "t2",
		});
		expect(replies2).toEqual([null]);

		await bot.stop();
	});
});
