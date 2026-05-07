import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createPendingAction,
	createUser,
	getLeaveRecordsByStatus,
	getPendingActionById,
	openDatabase,
	runMigrations,
	updateLeaveRecordStatus,
	updatePendingActionBotMessageTs,
	updatePendingActionStatus,
	upsertLeaveRecord,
} from "../src/db/index.js";
import type { DbUser } from "../src/db/types.js";
import { BackgroundWorker, type WorkerDeps } from "../src/worker.js";
import { MockCalendarService, MockHarvestService, MockSlackService } from "./mocks.js";

// ─── Helpers ────────────────────────────────────────────

let db: Database;
let calendar: MockCalendarService;
let harvest: MockHarvestService;
let slack: MockSlackService;
let worker: BackgroundWorker;
let user: DbUser;

function deps(): WorkerDeps {
	return { db, calendar, harvest, slack };
}

function futureExpiry(): string {
	return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function pastExpiry(): string {
	return new Date(Date.now() - 60 * 1000).toISOString();
}

beforeEach(() => {
	db = openDatabase({ dbPath: ":memory:" });
	runMigrations(db, "./migrations");
	calendar = new MockCalendarService();
	harvest = new MockHarvestService();
	slack = new MockSlackService();

	user = createUser(db, {
		slackUserId: "U_ALICE",
		slackDisplayName: "Alice",
		email: "alice@example.com",
		harvestUserId: 42,
	});
});

afterEach(() => {
	if (worker?.isRunning) worker.stop();
	db.close();
});

// ─── processTick: create_leave ──────────────────────────

describe("processTick — create_leave", () => {
	it("syncs a confirmed leave to Calendar + Harvest and marks completed", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation", reason: "holiday" },
			slackChannelId: "C1",
			slackMessageTs: "msg-1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		// Pending action should be completed
		const updated = getPendingActionById(db, action.id);
		expect(updated?.status).toBe("completed");

		// Calendar event created
		expect(calendar.createdEvents).toHaveLength(1);
		expect(calendar.createdEvents[0].summary).toContain("Alice");
		expect(calendar.createdEvents[0].summary).toContain("vacation");
		expect(calendar.createdEvents[0].allDay).toBe(true);
		expect(calendar.createdEvents[0].start.toISOString().slice(0, 10)).toBe("2026-04-01");
		expect(calendar.createdEvents[0].end.toISOString().slice(0, 10)).toBe("2026-04-02");

		// Harvest entry created
		expect(harvest.createdEntries).toHaveLength(1);
		expect(harvest.createdEntries[0].harvestUserId).toBe(42);
		expect(harvest.createdEntries[0].date).toBe("2026-04-01");
		expect(harvest.createdEntries[0].category).toBe("vacation");

		// Leave record should be completed with sync IDs
		const records = getLeaveRecordsByStatus(db, "completed");
		expect(records).toHaveLength(1);
		expect(records[0].calendar_event_id).toBe("mock-1");
		expect(records[0].harvest_entry_id).toBe(1000);

		// Slack message updated with success
		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].options.text).toContain("✅");
		expect(slack.updatedMessages[0].options.text).toContain("2026-04-01");
	});

	it("handles multiple dates in a single action", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01", "2026-04-02", "2026-04-03"], leaveType: "full", category: "sick" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("completed");
		expect(calendar.createdEvents).toHaveLength(3);
		expect(harvest.createdEntries).toHaveLength(3);
		expect(getLeaveRecordsByStatus(db, "completed")).toHaveLength(3);
	});

	it("skips Harvest when user has no harvest_user_id", async () => {
		const noHarvestUser = createUser(db, {
			slackUserId: "U_BOB",
			slackDisplayName: "Bob",
		});

		const action = createPendingAction(db, {
			userId: noHarvestUser.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("completed");
		expect(calendar.createdEvents).toHaveLength(1);
		expect(harvest.createdEntries).toHaveLength(0);

		const records = getLeaveRecordsByStatus(db, "completed");
		expect(records).toHaveLength(1);
		expect(records[0].harvest_entry_id).toBeNull();
	});

	it("retries on Calendar failure and eventually fails", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		// Make calendar always fail
		const failCalendar = new MockCalendarService();
		failCalendar.createEvent = async () => {
			throw new Error("Calendar API down");
		};

		worker = new BackgroundWorker(
			{ db, calendar: failCalendar, harvest, slack },
			{ processIntervalMs: 999999, expiryIntervalMs: 999999, maxRetries: 2 },
		);

		// Tick 1: fails, retry_count → 1, action goes back to confirmed
		await worker.processTick();
		expect(getPendingActionById(db, action.id)?.status).toBe("confirmed");

		// Tick 2: fails again, retry_count → 2, now exceeds maxRetries(2)
		await worker.processTick();
		expect(getPendingActionById(db, action.id)?.status).toBe("failed");

		// Leave record should be failed
		const records = getLeaveRecordsByStatus(db, "failed");
		expect(records).toHaveLength(1);
		expect(records[0].error_message).toContain("Max retries");

		// Slack updated with failure
		expect(slack.updatedMessages.length).toBeGreaterThanOrEqual(1);
		const lastUpdate = slack.updatedMessages[slack.updatedMessages.length - 1];
		expect(lastUpdate.options.text).toContain("❌");
		expect(lastUpdate.options.text).toContain("Calendar");
		expect(lastUpdate.options.text).toContain("2026-04-01");
	});

	it("still processes leave for a deactivated user", async () => {
		// Deactivate user (soft delete) — worker should still process their confirmed actions
		db.run("UPDATE users SET is_active = 0 WHERE id = ?", [user.id]);

		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("completed");
		expect(calendar.createdEvents).toHaveLength(1);
	});

	it("does nothing when no confirmed actions exist", async () => {
		// Create a pending (not confirmed) action
		createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			expiresAt: futureExpiry(),
		});

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(calendar.createdEvents).toHaveLength(0);
		expect(harvest.createdEntries).toHaveLength(0);
	});

	it("processes multiple confirmed actions in one tick", async () => {
		const a1 = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, a1.id, "bot-1");
		updatePendingActionStatus(db, a1.id, "confirmed");

		const a2 = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-05"], leaveType: "half_am", category: "sick" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, a2.id, "bot-2");
		updatePendingActionStatus(db, a2.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, a1.id)?.status).toBe("completed");
		expect(getPendingActionById(db, a2.id)?.status).toBe("completed");
		expect(calendar.createdEvents).toHaveLength(2);
		expect(calendar.createdEvents[0].allDay).toBe(true);
		expect(calendar.createdEvents[1].allDay).toBeFalsy();
		expect(harvest.createdEntries).toHaveLength(2);
	});
});

// ─── processTick: cancel_leave ──────────────────────────

describe("processTick — cancel_leave", () => {
	it("cancels leave records and deletes Calendar + Harvest entries", async () => {
		// Set up existing completed leave records
		const record = upsertLeaveRecord(db, {
			userId: user.id,
			date: "2026-04-01",
			leaveType: "full",
			leaveCategory: "vacation",
			status: "completed",
		});
		updateLeaveRecordStatus(db, record.id, {
			status: "completed",
			calendarEventId: "cal-evt-1",
			harvestEntryId: 5001,
		});

		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "cancel_leave",
			payload: { dates: ["2026-04-01"] },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("completed");

		// Calendar and Harvest deletions
		expect(calendar.deletedIds).toEqual(["cal-evt-1"]);
		expect(harvest.deletedEntryIds).toEqual([5001]);

		// Leave record cancelled
		const records = getLeaveRecordsByStatus(db, "cancelled");
		expect(records).toHaveLength(1);

		// Slack notification
		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].options.text).toContain("cancelled");
	});

	it("handles cancellation when no external IDs exist", async () => {
		// Leave record with no calendar/harvest IDs (e.g., sync hadn't completed)
		upsertLeaveRecord(db, {
			userId: user.id,
			date: "2026-04-01",
			status: "confirmed",
		});

		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "cancel_leave",
			payload: { dates: ["2026-04-01"] },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("completed");
		expect(calendar.deletedIds).toHaveLength(0);
		expect(harvest.deletedEntryIds).toHaveLength(0);

		const records = getLeaveRecordsByStatus(db, "cancelled");
		expect(records).toHaveLength(1);
	});

	it("fails cancellation with a helpful message when no matching leave exists", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "cancel_leave",
			payload: { dates: ["2026-04-09"] },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-404");
		updatePendingActionStatus(db, action.id, "confirmed");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("failed");
		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].options.text).toContain("No matching leave record");
		expect(slack.updatedMessages[0].options.text).toContain("2026-04-09");
	});
});

// ─── expiryTick ─────────────────────────────────────────

describe("expiryTick", () => {
	it("expires stale pending actions and updates Slack", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: pastExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.expiryTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("expired");
		expect(slack.updatedMessages).toHaveLength(1);
		expect(slack.updatedMessages[0].options.text).toContain("⏰");
		expect(slack.updatedMessages[0].options.text).toContain("expired");
	});

	it("does not expire future actions", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			slackChannelId: "C1",
			expiresAt: futureExpiry(),
		});
		updatePendingActionBotMessageTs(db, action.id, "bot-msg-1");

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.expiryTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("pending");
		expect(slack.updatedMessages).toHaveLength(0);
	});

	it("skips Slack update when no bot message ts", async () => {
		const action = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			expiresAt: pastExpiry(),
			// no slackChannelId → no notification
		});

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.expiryTick();

		expect(getPendingActionById(db, action.id)?.status).toBe("expired");
		expect(slack.updatedMessages).toHaveLength(0);
	});
});

// ─── Worker lifecycle ───────────────────────────────────

describe("Worker lifecycle", () => {
	it("starts and stops", () => {
		worker = new BackgroundWorker(deps());
		expect(worker.isRunning).toBe(false);

		worker.start();
		expect(worker.isRunning).toBe(true);

		worker.stop();
		expect(worker.isRunning).toBe(false);
	});

	it("start is idempotent", () => {
		worker = new BackgroundWorker(deps());
		worker.start();
		worker.start(); // no-op
		expect(worker.isRunning).toBe(true);
		worker.stop();
	});

	it("stop is idempotent", () => {
		worker = new BackgroundWorker(deps());
		worker.start();
		worker.stop();
		worker.stop(); // no-op
		expect(worker.isRunning).toBe(false);
	});
});

// ─── claimConfirmedActions atomicity ────────────────────

describe("claimConfirmedActions", () => {
	it("transitions confirmed → processing atomically", async () => {
		const a1 = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-01"], leaveType: "full", category: "vacation" },
			expiresAt: futureExpiry(),
		});
		updatePendingActionStatus(db, a1.id, "confirmed");

		const a2 = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-02"], leaveType: "full", category: "vacation" },
			expiresAt: futureExpiry(),
		});
		updatePendingActionStatus(db, a2.id, "confirmed");

		// Pending action that should NOT be claimed
		const a3 = createPendingAction(db, {
			userId: user.id,
			actionType: "create_leave",
			payload: { dates: ["2026-04-03"], leaveType: "full", category: "vacation" },
			expiresAt: futureExpiry(),
		});
		// a3 stays in 'pending' status

		worker = new BackgroundWorker(deps(), { processIntervalMs: 999999, expiryIntervalMs: 999999 });
		await worker.processTick();

		// a1 and a2 processed, a3 untouched
		expect(getPendingActionById(db, a1.id)?.status).toBe("completed");
		expect(getPendingActionById(db, a2.id)?.status).toBe("completed");
		expect(getPendingActionById(db, a3.id)?.status).toBe("pending");
	});
});
