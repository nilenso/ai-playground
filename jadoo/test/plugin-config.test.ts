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
	it("resolves from dict by schema keys", () => {
		const schema: PluginConfigSchema = {
			channelId: {},
			keywords: {},
		};
		const configDict = { channelId: "C123", keywords: "foo,bar" };

		const config = resolvePluginConfig("test", schema, configDict);

		expect(config.channelId).toBe("C123");
		expect(config.keywords).toBe("foo,bar");
	});

	it("applies default values when unset", () => {
		const schema: PluginConfigSchema = {
			timezone: { default: "Asia/Kolkata" },
		};
		const configDict = {};

		const config = resolvePluginConfig("test", schema, configDict);

		expect(config.timezone).toBe("Asia/Kolkata");
	});

	it("dict overrides default", () => {
		const schema: PluginConfigSchema = {
			timezone: { default: "Asia/Kolkata" },
		};
		const configDict = { timezone: "America/New_York" };

		const config = resolvePluginConfig("test", schema, configDict);
		expect(config.timezone).toBe("America/New_York");
	});

	it("throws on missing required field", () => {
		const schema: PluginConfigSchema = {
			channelId: {}, // implicitly required=true
		};
		const configDict = {};

		expect(() => resolvePluginConfig("test", schema, configDict)).toThrow(/missing required config/);
	});

	it("error message includes name and description", () => {
		const schema: PluginConfigSchema = {
			channelId: { description: "Channel to listen in" },
		};

		try {
			resolvePluginConfig("leave", schema, {});
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("channelId");
			expect(msg).toContain("Channel to listen in");
		}
	});

	it("collects all missing required fields in one error", () => {
		const schema: PluginConfigSchema = {
			a: {},
			b: {},
		};

		try {
			resolvePluginConfig("multi", schema, {});
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("a");
			expect(msg).toContain("b");
		}
	});

	it("explicitly optional fields are undefined when unset", () => {
		const schema: PluginConfigSchema = {
			opt: { required: false },
		};

		const config = resolvePluginConfig("test", schema, {});
		expect(config.opt).toBeUndefined();
	});

	it("treats empty string as unset", () => {
		const schema: PluginConfigSchema = {
			a: { default: "fallback" },
		};

		const config = resolvePluginConfig("test", schema, { a: "" });
		expect(config.a).toBe("fallback");
	});

	it("returns empty object for empty schema", () => {
		const config = resolvePluginConfig("empty", {}, { foo: "bar" });
		expect(Object.keys(config).length).toBe(0);
	});

	it("field with default is not required even without explicit required: false", () => {
		const schema: PluginConfigSchema = {
			a: { default: "fallback" },
		};

		const config = resolvePluginConfig("test", schema, {});
		expect(config.a).toBe("fallback");
	});
});

describe("Bot resolves plugin config", () => {
	it("passes empty config when plugin has no configSchema", async () => {
		const services = createServices();
		const bot = new Bot(services);

		let receivedConfig: Record<string, any> | undefined;

		const plugin: Plugin = {
			name: "simple",
			init(_ctx, config) {
				receivedConfig = config;
			},
		};

		bot.register(plugin);
		await bot.start();

		expect(receivedConfig).toBeDefined();
		expect(Object.keys(receivedConfig!).length).toBe(0);
        await bot.stop();
	});

    it("fails fast when required config is missing", async () => {
		const services = createServices();

		const plugin: Plugin = {
			name: "needs-config",
			configSchema: { channelId: { description: "Required channel" } },
			init() {},
		};

		const bot = new Bot(services, { pluginConfigs: {} });
		bot.register(plugin);

		await expect(bot.start()).rejects.toThrow("channelId");
	});

	it("each plugin instance gets its own resolved config", async () => {
		const services = createServices();
		const bot = new Bot(services, {
			pluginConfigs: {
				alpha: { channel: "CA" },
				"beta_1": { channel: "CB1" },
				"beta_2": { channel: "CB2", extra: "different" },
			},
		});

		let alphaConfig: any;
		bot.register({
			name: "alpha",
			configSchema: { channel: {} },
			init(_, config) {
				alphaConfig = config;
			},
		});

		let beta1Config: any;
		bot.register({
			name: "beta",
			configSchema: { channel: {}, extra: { default: "default-val" } },
			init(_, config) {
				beta1Config = config;
			},
		}, "1");

		let beta2Config: any;
		bot.register({
			name: "beta",
			configSchema: { channel: {}, extra: { default: "default-val" } },
			init(_, config) {
				beta2Config = config;
			},
		}, "2");

		await bot.start();

		expect(alphaConfig.channel).toBe("CA");
		expect(beta1Config.channel).toBe("CB1");
		expect(beta1Config.extra).toBe("default-val");
		expect(beta2Config.channel).toBe("CB2");
		expect(beta2Config.extra).toBe("different");
        await bot.stop();
	});

	it("plugin can use config in message handlers", async () => {
		const services = createServices();
		const mockSlack = services.slack as MockSlackService;
		const bot = new Bot(services, { pluginConfigs: { "channel-filter": { channelId: "C123" } } });

		const plugin: Plugin = {
			name: "channel-filter",
			configSchema: { channelId: {} },
			init(ctx, config) {
				ctx.slack.onMessage(async (msg) => {
					if (msg.channelId === config.channelId) {
						return "filtered reply";
					}
					return null;
				});
			},
		};

		bot.register(plugin);
		await bot.start();

		// Simulate message in matching channel
		await mockSlack.simulateMessage({ channelId: "C123", text: "hello", userId: "U1", ts: "1", threadTs: undefined });
		expect(mockSlack.postedMessages.length).toBe(0);

		// Simulate message in wrong channel
		await mockSlack.simulateMessage({ channelId: "C999", text: "hello", userId: "U1", ts: "2", threadTs: undefined });
		expect(mockSlack.postedMessages.length).toBe(0);

		await bot.stop();
	});
});
