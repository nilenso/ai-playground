import { describe, expect, it } from "bun:test";
import { MockAIService, MockCalendarService, MockSlackService } from "./mocks.js";

describe("MockAIService", () => {
	it("returns default response when no responses queued", async () => {
		const ai = new MockAIService();
		const result = await ai.complete({ messages: [{ role: "user", content: "hello" }] });
		expect(result.content).toBe("mock response");
		expect(result.stopReason).toBe("stop");
	});

	it("returns queued responses in order", async () => {
		const ai = new MockAIService();
		ai.responses.push({ content: "first", stopReason: "stop" }, { content: "second", stopReason: "stop" });

		const r1 = await ai.complete({ messages: [{ role: "user", content: "a" }] });
		const r2 = await ai.complete({ messages: [{ role: "user", content: "b" }] });
		const r3 = await ai.complete({ messages: [{ role: "user", content: "c" }] });

		expect(r1.content).toBe("first");
		expect(r2.content).toBe("second");
		expect(r3.content).toBe("mock response"); // falls back to default
	});

	it("records all requests", async () => {
		const ai = new MockAIService();
		await ai.complete({ messages: [{ role: "user", content: "hello" }], systemPrompt: "be nice" });
		expect(ai.requests).toHaveLength(1);
		expect(ai.requests[0].systemPrompt).toBe("be nice");
	});
});

describe("MockCalendarService", () => {
	it("creates and lists events", async () => {
		const cal = new MockCalendarService();

		const start = new Date("2026-03-16T09:00:00Z");
		const end = new Date("2026-03-16T10:00:00Z");

		const created = await cal.createEvent({ summary: "Standup", start, end });
		expect(created.id).toBe("mock-1");
		expect(created.summary).toBe("Standup");

		const events = await cal.listEvents({
			timeMin: new Date("2026-03-16T00:00:00Z"),
			timeMax: new Date("2026-03-16T23:59:59Z"),
		});
		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe("Standup");
	});

	it("deletes events", async () => {
		const cal = new MockCalendarService();

		const start = new Date("2026-03-16T09:00:00Z");
		const end = new Date("2026-03-16T10:00:00Z");

		const created = await cal.createEvent({ summary: "Delete me", start, end });
		await cal.deleteEvent(created.id);

		expect(cal.deletedIds).toContain(created.id);
		expect(cal.events).toHaveLength(0);
	});

	it("filters events by time range", async () => {
		const cal = new MockCalendarService();

		await cal.createEvent({
			summary: "Yesterday",
			start: new Date("2026-03-15T09:00:00Z"),
			end: new Date("2026-03-15T10:00:00Z"),
		});
		await cal.createEvent({
			summary: "Today",
			start: new Date("2026-03-16T09:00:00Z"),
			end: new Date("2026-03-16T10:00:00Z"),
		});

		const todayOnly = await cal.listEvents({
			timeMin: new Date("2026-03-16T00:00:00Z"),
			timeMax: new Date("2026-03-16T23:59:59Z"),
		});

		expect(todayOnly).toHaveLength(1);
		expect(todayOnly[0].summary).toBe("Today");
	});
});

describe("MockSlackService", () => {
	// ── Messages ─────────────────────────────

	it("registers handlers and simulates messages", async () => {
		const slack = new MockSlackService();
		slack.onMessage(async (msg) => `echo: ${msg.text}`);

		const replies = await slack.simulateMessage({
			text: "hello",
			userId: "U123",
			channelId: "C456",
			ts: "ts123",
		});

		expect(replies).toEqual(["echo: hello"]);
	});

	it("supports multiple message handlers", async () => {
		const slack = new MockSlackService();
		slack.onMessage(async (msg) => `handler1: ${msg.text}`);
		slack.onMessage(async (msg) => `handler2: ${msg.text}`);

		const replies = await slack.simulateMessage({
			text: "yo",
			userId: "U1",
			channelId: "C1",
			ts: "ts1",
		});

		expect(replies).toEqual(["handler1: yo", "handler2: yo"]);
	});

	// ── Post / Update ────────────────────────

	it("posts a text-only message", async () => {
		const slack = new MockSlackService();

		const sent = await slack.postMessage("C123", { text: "plain text" });
		expect(sent.ts).toMatch(/^mock-ts-/);
		expect(slack.postedMessages).toHaveLength(1);
		expect(slack.postedMessages[0].options.text).toBe("plain text");
		expect(slack.postedMessages[0].options.blocks).toBeUndefined();
	});

	it("assigns unique timestamps to each posted message", async () => {
		const slack = new MockSlackService();

		const s1 = await slack.postMessage("C1", { text: "first" });
		const s2 = await slack.postMessage("C1", { text: "second" });
		expect(s1.ts).not.toBe(s2.ts);
	});

	it("posts messages with blocks and records them", async () => {
		const slack = new MockSlackService();

		const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Hello *world*" } }, { type: "divider" }];

		const sent = await slack.postMessage("C123", {
			text: "fallback",
			blocks,
			threadTs: "thread-1",
		});

		expect(sent.ts).toMatch(/^mock-ts-/);
		expect(sent.channelId).toBe("C123");

		expect(slack.postedMessages).toHaveLength(1);
		expect(slack.postedMessages[0].options.blocks).toEqual(blocks);
		expect(slack.postedMessages[0].options.threadTs).toBe("thread-1");
	});

	it("updates messages and records them", async () => {
		const slack = new MockSlackService();

		await slack.updateMessage("C123", "original-ts", {
			blocks: [{ type: "section", text: { type: "mrkdwn", text: "Updated!" } }],
		});

		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].channel).toBe("C123");
		expect(slack.updatedMessages[0].ts).toBe("original-ts");
	});

	// ── Actions ──────────────────────────────

	it("dispatches actions to matching handlers", async () => {
		const slack = new MockSlackService();
		const received: string[] = [];

		slack.onAction(/leave_confirm_.*/, async (event) => {
			received.push(`confirm:${event.value}`);
		});
		slack.onAction(/leave_cancel_.*/, async (event) => {
			received.push(`cancel:${event.value}`);
		});

		await slack.simulateAction({
			actionId: "leave_confirm_abc123",
			value: "abc123",
			userId: "U1",
			channelId: "C1",
			messageTs: "ts1",
		});

		expect(received).toEqual(["confirm:abc123"]);
	});

	it("ignores actions that don't match any pattern", async () => {
		const slack = new MockSlackService();
		const received: string[] = [];

		slack.onAction(/leave_confirm_.*/, async () => {
			received.push("confirm");
		});

		await slack.simulateAction({
			actionId: "some_other_action",
			value: "x",
			userId: "U1",
			channelId: "C1",
			messageTs: "ts1",
		});

		expect(received).toHaveLength(0);
	});

	it("dispatches slash commands and records ephemeral responses", async () => {
		const slack = new MockSlackService();
		const received: string[] = [];

		slack.onCommand("/jadoo-sync", async (event) => {
			received.push(`${event.command}:${event.text}`);
			await event.respond({ text: "done" });
		});

		await slack.simulateCommand({
			command: "/jadoo-sync",
			text: "",
			userId: "U1",
			channelId: "C1",
		});

		expect(received).toEqual(["/jadoo-sync:"]);
		expect(slack.commandResponses).toHaveLength(1);
		expect(slack.commandResponses[0].options.text).toBe("done");
	});

	// ── Thread replies ───────────────────────

	it("returns seeded thread replies", async () => {
		const slack = new MockSlackService();

		slack.addThreadReplies("C1", "parent-ts", [
			{ text: "first reply", userId: "U1", channelId: "C1", ts: "r1", threadTs: "parent-ts" },
			{ text: "second reply", userId: "U2", channelId: "C1", ts: "r2", threadTs: "parent-ts" },
		]);

		const replies = await slack.getThreadReplies("C1", "parent-ts");
		expect(replies).toHaveLength(2);
		expect(replies[0].text).toBe("first reply");
		expect(replies[1].userId).toBe("U2");
	});

	it("returns empty array for unknown threads", async () => {
		const slack = new MockSlackService();
		const replies = await slack.getThreadReplies("C1", "no-such-thread");
		expect(replies).toEqual([]);
	});

	// ── User info ────────────────────────────

	it("returns seeded user info", async () => {
		const slack = new MockSlackService();

		slack.addUser({
			userId: "U_ALICE",
			displayName: "Alice",
			email: "alice@example.com",
			timezone: "Asia/Kolkata",
			isBot: false,
		});

		const info = await slack.getUserInfo("U_ALICE");
		expect(info.displayName).toBe("Alice");
		expect(info.email).toBe("alice@example.com");
		expect(info.timezone).toBe("Asia/Kolkata");
		expect(info.isBot).toBe(false);
	});

	it("returns default user info for unknown users", async () => {
		const slack = new MockSlackService();
		const info = await slack.getUserInfo("U_UNKNOWN");
		expect(info.userId).toBe("U_UNKNOWN");
		expect(info.displayName).toBe("User U_UNKNOWN");
		expect(info.isBot).toBe(false);
	});

	// ── Lifecycle ────────────────────────────

	it("tracks start/stop state", async () => {
		const slack = new MockSlackService();
		expect(slack.isRunning).toBe(false);
		await slack.start();
		expect(slack.isRunning).toBe(true);
		await slack.stop();
		expect(slack.isRunning).toBe(false);
	});
});
