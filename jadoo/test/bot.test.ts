import { describe, expect, it } from "bun:test";
import { Bot } from "../src/bot.js";
import type { BotContext, Plugin } from "../src/interfaces/plugin.js";
import { MockAIService, MockCalendarService, MockHarvestService, MockSlackService } from "./mocks.js";

function createServices() {
	return {
		ai: new MockAIService(),
		calendar: new MockCalendarService(),
		harvest: new MockHarvestService(),
		slack: new MockSlackService(),
	};
}

describe("Bot", () => {
	it("starts and stops", async () => {
		const services = createServices();
		const bot = new Bot(services);

		expect(bot.isRunning).toBe(false);
		await bot.start();
		expect(bot.isRunning).toBe(true);
		expect(services.slack.isRunning).toBe(true);
		await bot.stop();
		expect(bot.isRunning).toBe(false);
		expect(services.slack.isRunning).toBe(false);
	});

	it("initializes plugins in registration order", async () => {
		const services = createServices();
		const bot = new Bot(services);
		const order: string[] = [];

		const pluginA: Plugin = {
			name: "alpha",
			init: () => {
				order.push("alpha");
			},
		};
		const pluginB: Plugin = {
			name: "beta",
			init: () => {
				order.push("beta");
			},
		};

		bot.register(pluginA).register(pluginB);
		await bot.start();

		expect(order).toEqual(["alpha", "beta"]);
		await bot.stop();
	});

	it("stops plugins in reverse order", async () => {
		const services = createServices();
		const bot = new Bot(services);
		const order: string[] = [];

		bot.register({
			name: "first",
			init() {},
			stop: () => {
				order.push("first");
			},
		});
		bot.register({
			name: "second",
			init() {},
			stop: () => {
				order.push("second");
			},
		});

		await bot.start();
		await bot.stop();

		expect(order).toEqual(["second", "first"]);
	});

	it("rejects plugin registration after start", async () => {
		const services = createServices();
		const bot = new Bot(services);
		await bot.start();

		expect(() => bot.register({ name: "late", init() {} })).toThrow("after bot has started");
		await bot.stop();
	});

	it("exposes registered plugins", () => {
		const services = createServices();
		const bot = new Bot(services);
		const p: Plugin = { name: "test", init() {} };

		bot.register(p);
		expect(bot.registeredPlugins).toEqual([p]);
	});
});

describe("Plugin receives BotContext", () => {
	it("plugin can use AI + Calendar + Slack from context", async () => {
		const services = createServices();
		services.ai.defaultResponse = {
			content: '{"name":"Alice","date":"2026-03-16","reason":"sick"}',
			stopReason: "stop",
		};

		const bot = new Bot(services);

		// A minimal leave plugin
		const leavePlugin: Plugin = {
			name: "leave",
			init(ctx: BotContext) {
				ctx.slack.onMessage(async (msg) => {
					if (!msg.text.toLowerCase().includes("leave")) return null;

					const response = await ctx.ai.complete({
						systemPrompt: "Parse leave request as JSON",
						messages: [{ role: "user", content: msg.text }],
					});

					await ctx.calendar.createEvent({
						summary: `Leave: ${msg.userId}`,
						start: new Date("2026-03-16T00:00:00Z"),
						end: new Date("2026-03-17T00:00:00Z"),
					});

					return `Recorded! ${response.content}`;
				});
			},
		};

		bot.register(leavePlugin);
		await bot.start();

		// Simulate a message
		const replies = await services.slack.simulateMessage({
			text: "I need leave tomorrow",
			userId: "U_ALICE",
			channelId: "C1",
			ts: "ts1",
		});

		expect(replies[0]).toContain("Recorded!");
		expect(services.ai.requests).toHaveLength(1);
		expect(services.calendar.createdEvents).toHaveLength(1);
		expect(services.calendar.createdEvents[0].summary).toBe("Leave: U_ALICE");

		await bot.stop();
	});
});

describe("Plugin uses Block Kit and actions", () => {
	it("plugin posts blocks and handles button clicks", async () => {
		const services = createServices();
		const bot = new Bot(services);

		bot.register({
			name: "confirm-flow",
			init(ctx) {
				ctx.slack.onMessage(async (msg) => {
					if (!msg.text.includes("leave")) return null;

					// Post a confirmation message with buttons
					await ctx.slack.postMessage(msg.channelId, {
						text: "Leave request",
						blocks: [
							{ type: "section", text: { type: "mrkdwn", text: `*Leave request* from <@${msg.userId}>` } },
							{
								type: "actions",
								elements: [
									{ type: "button", text: { type: "plain_text", text: "Confirm" }, action_id: "leave_confirm_1" },
									{ type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "leave_cancel_1" },
								],
							},
						],
						threadTs: msg.ts,
					});
					return null; // don't auto-reply, we posted blocks instead
				});

				ctx.slack.onAction(/leave_confirm_.*/, async (event) => {
					await ctx.slack.updateMessage(event.channelId, event.messageTs, {
						text: "✅ Leave confirmed!",
						blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ Leave confirmed!" } }],
					});
				});

				ctx.slack.onAction(/leave_cancel_.*/, async (event) => {
					await ctx.slack.updateMessage(event.channelId, event.messageTs, {
						text: "❌ Leave cancelled.",
					});
				});
			},
		});

		await bot.start();

		// Step 1: User sends a message
		await services.slack.simulateMessage({
			text: "I need leave tomorrow",
			userId: "U_ALICE",
			channelId: "C1",
			ts: "msg-ts-1",
		});

		// Verify blocks were posted
		expect(services.slack.postedMessages).toHaveLength(1);
		const posted = services.slack.postedMessages[0];
		expect(posted.options.threadTs).toBe("msg-ts-1");
		expect(posted.options.blocks).toHaveLength(2);

		// Step 2: User clicks "Confirm"
		await services.slack.simulateAction({
			actionId: "leave_confirm_1",
			value: "1",
			userId: "U_ALICE",
			channelId: "C1",
			messageTs: posted.ts,
		});

		// Verify message was updated
		expect(services.slack.updatedMessages).toHaveLength(1);
		expect(services.slack.updatedMessages[0].ts).toBe(posted.ts);
		expect(services.slack.updatedMessages[0].options.text).toBe("✅ Leave confirmed!");

		await bot.stop();
	});

	it("plugin uses thread context and user info", async () => {
		const services = createServices();

		// Seed user info
		services.slack.addUser({
			userId: "U_BOB",
			displayName: "Bob",
			email: "bob@example.com",
			timezone: "America/New_York",
			isBot: false,
		});

		// Seed thread replies
		services.slack.addThreadReplies("C1", "thread-parent", [
			{ text: "I'll be out next week", userId: "U_BOB", channelId: "C1", ts: "r1", threadTs: "thread-parent" },
			{ text: "Monday and Tuesday", userId: "U_BOB", channelId: "C1", ts: "r2", threadTs: "thread-parent" },
		]);

		const bot = new Bot(services);
		const collectedContext: { userName: string; timezone: string; threadMessages: number } = {
			userName: "",
			timezone: "",
			threadMessages: 0,
		};

		bot.register({
			name: "context-aware",
			init(ctx) {
				ctx.slack.onMessage(async (msg) => {
					// Look up user info
					const userInfo = await ctx.slack.getUserInfo(msg.userId);
					collectedContext.userName = userInfo.displayName;
					collectedContext.timezone = userInfo.timezone ?? "unknown";

					// Fetch thread context if in a thread
					if (msg.threadTs) {
						const thread = await ctx.slack.getThreadReplies(msg.channelId, msg.threadTs);
						collectedContext.threadMessages = thread.length;
					}

					return `Got it, ${userInfo.displayName}`;
				});
			},
		});

		await bot.start();

		const replies = await services.slack.simulateMessage({
			text: "actually, make it Wednesday too",
			userId: "U_BOB",
			channelId: "C1",
			ts: "r3",
			threadTs: "thread-parent",
		});

		expect(replies[0]).toBe("Got it, Bob");
		expect(collectedContext.userName).toBe("Bob");
		expect(collectedContext.timezone).toBe("America/New_York");
		expect(collectedContext.threadMessages).toBe(2);

		await bot.stop();
	});
});

describe("Multiple plugins", () => {
	it("multiple plugins handle the same message independently", async () => {
		const services = createServices();
		const bot = new Bot(services);

		bot.register({
			name: "greeter",
			init(ctx) {
				ctx.slack.onMessage(async (msg) => {
					if (msg.text.includes("hello")) return "Hi there!";
					return null;
				});
			},
		});

		bot.register({
			name: "logger",
			init(ctx) {
				ctx.slack.onMessage(async () => {
					// Logger always returns null (no reply), but we can verify it ran
					return null;
				});
			},
		});

		await bot.start();

		const replies = await services.slack.simulateMessage({
			text: "hello bot",
			userId: "U1",
			channelId: "C1",
			ts: "ts1",
		});

		// Both handlers ran: greeter replied, logger returned null
		expect(replies).toEqual(["Hi there!", null]);

		await bot.stop();
	});
});
