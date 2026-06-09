import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	createLeaveRecord,
	createPendingAction,
	createUser,
	getPendingActionById,
	getPendingActionsByStatus,
	openDatabase,
	runMigrations,
} from "../src/db/index.js";
import type { BotContext } from "../src/interfaces/plugin.js";
import { LeavePlugin } from "../src/plugins/leave/index.js";
import { MockAIService, MockCalendarService, MockHarvestService, MockSlackService } from "./mocks.js";

let db: Database;
let ai: MockAIService;
let slack: MockSlackService;
let ctx: BotContext;

function getActionButtons(postedMessage: (typeof slack.postedMessages)[number]) {
	return (postedMessage.options.blocks ?? []).flatMap((block) => {
		if ((block as { type?: string }).type !== "actions") return [];
		return ((block as { elements?: unknown[] }).elements ?? []) as Array<{
			action_id?: string;
			value?: string;
			text?: { text?: string };
		}>;
	});
}

beforeEach(() => {
	db = openDatabase({ dbPath: ":memory:" });
	runMigrations(db, "./migrations");
	ai = new MockAIService();
	slack = new MockSlackService();
	ctx = {
		ai,
		calendar: new MockCalendarService(),
		harvest: new MockHarvestService(),
		slack,
	};

	slack.addUser({
		userId: "U_NEENA",
		displayName: "neena",
		email: "neena@example.com",
		timezone: "Asia/Kolkata",
		isBot: false,
	});
});

describe("LeavePlugin", () => {
	it("uses button-based options instead of asking for clarification on low-confidence leave messages", async () => {
		ai.structuredResponses.push({
			is_leave_request: true,
			is_cancellation: false,
			confidence: "low",
			dates: [],
			original_text_summary: "I will take the day off tomorrow.",
			ambiguity_notes: "Tomorrow can be inferred, but the parser was unsure.",
		});

		const plugin = new LeavePlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE", keywords: "leave,off" });

		const replies = await slack.simulateMessage({
			text: "I will take the day off tomorrow.",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			ts: "msg-1",
		});

		expect(replies).toEqual([null]);
		expect(slack.postedMessages).toHaveLength(1);

		const buttons = getActionButtons(slack.postedMessages[0]);
		expect(buttons.some((button) => button.action_id?.startsWith("leave_select_create_option"))).toBe(true);
		expect(buttons.some((button) => button.action_id === "leave_dismiss_option")).toBe(true);
		expect(new Set(buttons.map((button) => button.action_id)).size).toBe(buttons.length);

		const createButton = buttons.find((button) => button.action_id?.startsWith("leave_select_create_option"));
		expect(createButton?.value).toBeTruthy();

		await slack.simulateAction({
			actionId: createButton?.action_id ?? "leave_select_create_option",
			value: createButton?.value ?? "",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			messageTs: slack.postedMessages[0].ts,
			threadTs: "msg-1",
		});

		expect(slack.updatedMessages).toHaveLength(1);
		const updatedBlocks = slack.updatedMessages[0].options.blocks ?? [];
		const updatedButtons = updatedBlocks.flatMap((block) => {
			if ((block as { type?: string }).type !== "actions") return [];
			return ((block as { elements?: unknown[] }).elements ?? []) as Array<{ action_id?: string }>;
		});
		expect(updatedButtons.some((button) => button.action_id === "leave_confirm")).toBe(true);

		const pending = getPendingActionsByStatus(db, "pending");
		expect(pending).toHaveLength(1);
		expect(pending[0].action_type).toBe("create_leave");
		expect(pending[0].payload).toContain("tomorrow");
	});

	it("uses button-based options when a time-specific leave is missing an end time", async () => {
		ai.structuredResponses.push({
			is_leave_request: true,
			is_cancellation: false,
			confidence: "low",
			dates: [
				{
					date: "2026-06-12",
					type: "specific",
					start_time: "10:00",
					category: "vacation",
				},
			],
			original_text_summary: "I need leave on June 12 from 10:00.",
			ambiguity_notes: "End time is missing.",
		});

		const plugin = new LeavePlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE", keywords: "leave,off" });

		const replies = await slack.simulateMessage({
			text: "I need leave on June 12 from 10:00.",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			ts: "msg-specific-missing-end",
		});

		expect(replies).toEqual([null]);
		expect(slack.postedMessages).toHaveLength(1);

		const buttons = getActionButtons(slack.postedMessages[0]);
		expect(buttons.some((button) => button.action_id?.startsWith("leave_select_create_option"))).toBe(true);
		expect(buttons.some((button) => button.action_id === "leave_dismiss_option")).toBe(true);
		expect(new Set(buttons.map((button) => button.action_id)).size).toBe(buttons.length);

		const createButton = buttons.find((button) => button.action_id?.startsWith("leave_select_create_option"));
		expect(createButton?.value).toContain('"endTime"');

		await slack.simulateAction({
			actionId: createButton?.action_id ?? "leave_select_create_option",
			value: createButton?.value ?? "",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			messageTs: slack.postedMessages[0].ts,
			threadTs: "msg-specific-missing-end",
		});

		expect(slack.updatedMessages).toHaveLength(1);
		const updatedBlocks = slack.updatedMessages[0].options.blocks ?? [];
		const updatedButtons = updatedBlocks.flatMap((block) => {
			if ((block as { type?: string }).type !== "actions") return [];
			return ((block as { elements?: unknown[] }).elements ?? []) as Array<{ action_id?: string }>;
		});
		expect(updatedButtons.some((button) => button.action_id === "leave_confirm")).toBe(true);
		expect(getPendingActionsByStatus(db, "pending")).toHaveLength(1);
	});

	it("uses button-based cancellation choices instead of asking for thread replies", async () => {
		const user = createUser(db, {
			slackUserId: "U_NEENA",
			slackDisplayName: "neena",
			email: "neena@example.com",
			slackTimezone: "Asia/Kolkata",
		});
		createLeaveRecord(db, {
			userId: user.id,
			date: "2026-06-12",
			leaveType: "full",
			leaveCategory: "vacation",
			status: "completed",
		});

		ai.structuredResponses.push({
			is_leave_request: false,
			is_cancellation: true,
			confidence: "high",
			dates: [],
			original_text_summary: "cancel my leave",
			ambiguity_notes: "",
		});

		const plugin = new LeavePlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE", keywords: "leave,cancel" });

		const replies = await slack.simulateMessage({
			text: "cancel my leave",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			ts: "msg-2",
		});

		expect(replies).toEqual([null]);
		expect(slack.postedMessages).toHaveLength(1);

		const buttons = getActionButtons(slack.postedMessages[0]);
		expect(buttons.some((button) => button.action_id?.startsWith("leave_select_cancel_option"))).toBe(true);
		expect(buttons.some((button) => button.action_id === "leave_dismiss_option")).toBe(true);
		expect(new Set(buttons.map((button) => button.action_id)).size).toBe(buttons.length);

		const cancelButton = buttons.find((button) => button.action_id?.startsWith("leave_select_cancel_option"));
		expect(cancelButton?.value).toBeTruthy();

		await slack.simulateAction({
			actionId: cancelButton?.action_id ?? "leave_select_cancel_option",
			value: cancelButton?.value ?? "",
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			messageTs: slack.postedMessages[0].ts,
			threadTs: "msg-2",
		});

		expect(slack.updatedMessages).toHaveLength(1);
		const updatedBlocks = slack.updatedMessages[0].options.blocks ?? [];
		const updatedButtons = updatedBlocks.flatMap((block) => {
			if ((block as { type?: string }).type !== "actions") return [];
			return ((block as { elements?: unknown[] }).elements ?? []) as Array<{ action_id?: string }>;
		});
		expect(updatedButtons.some((button) => button.action_id === "leave_confirm_cancel")).toBe(true);
	});

	it("confirms undo actions from the success message", async () => {
		const user = createUser(db, {
			slackUserId: "U_NEENA",
			slackDisplayName: "neena",
			email: "neena@example.com",
			slackTimezone: "Asia/Kolkata",
		});
		const undoAction = createPendingAction(db, {
			userId: user.id,
			actionType: "cancel_leave",
			payload: {
				dates: ["2026-06-12"],
				source: "undo",
				leaveType: "full",
				category: "vacation",
			},
			slackChannelId: "C_LEAVE",
			slackMessageTs: "msg-3",
			slackThreadTs: "msg-3",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});

		const plugin = new LeavePlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE", keywords: "leave,cancel" });

		await slack.simulateAction({
			actionId: "leave_undo",
			value: undoAction.id,
			userId: "U_NEENA",
			channelId: "C_LEAVE",
			messageTs: "bot-msg-undo",
			threadTs: "msg-3",
		});

		expect(getPendingActionById(db, undoAction.id)?.status).toBe("confirmed");
		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].options.text).toContain("Undoing your leave");
	});
});
