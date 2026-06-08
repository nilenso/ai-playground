import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createLeaveRecord,
	createPendingAction,
	createUser,
	expirePendingActions,
	getLeaveRecordsByStatus,
	getLeaveRecordsByUserAndDates,
	getPendingActionById,
	getPendingActionsByStatus,
	getPendingActionsForThread,
	getUserById,
	getUserBySlackId,
	hasCompletedActionInThread,
	listUsers,
	openDatabase,
	runMigrations,
	updateLeaveRecordStatus,
	updatePendingActionStatus,
	updateUser,
	upsertLeaveRecord,
} from "../src/db/index.js";

let db: Database;

beforeEach(() => {
	db = openDatabase({ dbPath: ":memory:" });
	runMigrations(db, "./migrations");
});

afterEach(() => {
	db.close();
});

// ─── Users ──────────────────────────────────────────────

describe("Users", () => {
	it("creates a user", () => {
		const user = createUser(db, {
			slackUserId: "U123",
			slackDisplayName: "Alice",
			email: "alice@example.com",
			slackTimezone: "Asia/Kolkata",
			harvestUserId: 42,
		});

		expect(user.id).toBeGreaterThan(0);
		expect(user.slack_user_id).toBe("U123");
		expect(user.slack_display_name).toBe("Alice");
		expect(user.email).toBe("alice@example.com");
		expect(user.harvest_user_id).toBe(42);
		expect(user.is_active).toBe(1);
	});

	it("enforces unique slack_user_id", () => {
		createUser(db, { slackUserId: "U123", slackDisplayName: "Alice" });
		expect(() => createUser(db, { slackUserId: "U123", slackDisplayName: "Bob" })).toThrow();
	});

	it("gets user by id", () => {
		const created = createUser(db, { slackUserId: "U123", slackDisplayName: "Alice" });
		const found = getUserById(db, created.id);
		expect(found).not.toBeNull();
		expect(found?.slack_display_name).toBe("Alice");
	});

	it("gets user by slack id (active only)", () => {
		createUser(db, { slackUserId: "U123", slackDisplayName: "Alice" });
		expect(getUserBySlackId(db, "U123")).not.toBeNull();
		expect(getUserBySlackId(db, "U999")).toBeNull();
	});

	it("updates a user", () => {
		const user = createUser(db, { slackUserId: "U123", slackDisplayName: "Alice" });
		const updated = updateUser(db, user.id, {
			slackDisplayName: "Alice Smith",
			harvestUserId: 99,
		});
		expect(updated?.slack_display_name).toBe("Alice Smith");
		expect(updated?.harvest_user_id).toBe(99);
	});

	it("deactivates a user", () => {
		const user = createUser(db, { slackUserId: "U123", slackDisplayName: "Alice" });
		updateUser(db, user.id, { isActive: false });

		// getUserBySlackId only returns active users
		expect(getUserBySlackId(db, "U123")).toBeNull();

		// getUserById still returns them
		const found = getUserById(db, user.id);
		expect(found?.is_active).toBe(0);
	});

	it("lists users", () => {
		createUser(db, { slackUserId: "U1", slackDisplayName: "Bob" });
		createUser(db, { slackUserId: "U2", slackDisplayName: "Alice" });

		const all = listUsers(db);
		expect(all).toHaveLength(2);
		// Sorted by display name
		expect(all[0].slack_display_name).toBe("Alice");
		expect(all[1].slack_display_name).toBe("Bob");
	});

	it("defaults timezone to Asia/Kolkata", () => {
		const user = createUser(db, { slackUserId: "U1", slackDisplayName: "Alice" });
		expect(user.slack_timezone).toBe("Asia/Kolkata");
	});
});

// ─── Leave Records ──────────────────────────────────────

describe("Leave Records", () => {
	let userId: number;

	beforeEach(() => {
		userId = createUser(db, { slackUserId: "U1", slackDisplayName: "Alice" }).id;
	});

	it("creates a leave record", () => {
		const record = createLeaveRecord(db, {
			userId,
			date: "2026-03-16",
			leaveType: "specific",
			startTime: "10:00",
			endTime: "12:30",
			leaveCategory: "vacation",
		});

		expect(record.id).toBeGreaterThan(0);
		expect(record.user_id).toBe(userId);
		expect(record.date).toBe("2026-03-16");
		expect(record.leave_type).toBe("specific");
		expect(record.start_time).toBe("10:00");
		expect(record.end_time).toBe("12:30");
		expect(record.leave_category).toBe("vacation");
		expect(record.status).toBe("pending");
	});

	it("enforces unique user+date", () => {
		createLeaveRecord(db, { userId, date: "2026-03-16" });
		expect(() => createLeaveRecord(db, { userId, date: "2026-03-16" })).toThrow();
	});

	it("upserts leave records", () => {
		createLeaveRecord(db, { userId, date: "2026-03-16", leaveType: "full", leaveCategory: "vacation" });

		const upserted = upsertLeaveRecord(db, {
			userId,
			date: "2026-03-16",
			leaveType: "specific",
			startTime: "09:00",
			endTime: "11:00",
			leaveCategory: "sick",
		});

		expect(upserted.leave_type).toBe("specific");
		expect(upserted.start_time).toBe("09:00");
		expect(upserted.end_time).toBe("11:00");
		expect(upserted.leave_category).toBe("sick");
		expect(upserted.status).toBe("confirmed");
	});

	it("finds records by user and dates", () => {
		createLeaveRecord(db, { userId, date: "2026-03-16", status: "confirmed" });
		createLeaveRecord(db, { userId, date: "2026-03-17", status: "confirmed" });
		createLeaveRecord(db, { userId, date: "2026-03-18", status: "cancelled" });

		const found = getLeaveRecordsByUserAndDates(db, userId, ["2026-03-16", "2026-03-17", "2026-03-18"]);

		// Only pending/confirmed are returned
		expect(found).toHaveLength(2);
	});

	it("finds records by status", () => {
		createLeaveRecord(db, { userId, date: "2026-03-16", status: "confirmed" });
		createLeaveRecord(db, { userId, date: "2026-03-17", status: "pending" });

		expect(getLeaveRecordsByStatus(db, "confirmed")).toHaveLength(1);
		expect(getLeaveRecordsByStatus(db, "pending")).toHaveLength(1);
		expect(getLeaveRecordsByStatus(db, "completed")).toHaveLength(0);
	});

	it("updates leave record status with sync IDs", () => {
		const record = createLeaveRecord(db, { userId, date: "2026-03-16" });

		updateLeaveRecordStatus(db, record.id, {
			status: "completed",
			calendarEventId: "gcal-123",
			harvestEntryId: 456,
		});

		const updated = db
			.query<{ status: string; calendar_event_id: string; harvest_entry_id: number }, [number]>(
				"SELECT status, calendar_event_id, harvest_entry_id FROM leave_records WHERE id = ?",
			)
			.get(record.id);

		expect(updated?.status).toBe("completed");
		expect(updated?.calendar_event_id).toBe("gcal-123");
		expect(updated?.harvest_entry_id).toBe(456);
	});

	it("cascades on user delete", () => {
		createLeaveRecord(db, { userId, date: "2026-03-16" });
		db.run("DELETE FROM users WHERE id = ?", [userId]);

		expect(getLeaveRecordsByStatus(db, "pending")).toHaveLength(0);
	});
});

// ─── Pending Actions ────────────────────────────────────

describe("Pending Actions", () => {
	let userId: number;

	beforeEach(() => {
		userId = createUser(db, { slackUserId: "U1", slackDisplayName: "Alice" }).id;
	});

	it("creates a pending action", () => {
		const action = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: { dates: ["2026-03-16"] },
			slackEventId: "evt-1",
			slackChannelId: "C123",
			slackMessageTs: "ts1",
			expiresAt: "2026-03-16T12:00:00Z",
		});

		expect(action.id.length).toBeGreaterThan(0);
		expect(action.action_type).toBe("create_leave");
		expect(action.status).toBe("pending");
		expect(JSON.parse(action.payload)).toEqual({ dates: ["2026-03-16"] });
	});

	it("enforces unique slack_event_id", () => {
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			slackEventId: "evt-1",
			expiresAt: "2026-03-16T12:00:00Z",
		});

		expect(() =>
			createPendingAction(db, {
				userId,
				actionType: "create_leave",
				payload: {},
				slackEventId: "evt-1",
				expiresAt: "2026-03-16T12:00:00Z",
			}),
		).toThrow();
	});

	it("allows multiple actions with null slack_event_id", () => {
		const a1 = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-16T12:00:00Z",
		});
		const a2 = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-16T12:00:00Z",
		});

		expect(a1.id).not.toBe(a2.id);
	});

	it("gets action by id", () => {
		const created = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-16T12:00:00Z",
		});

		const found = getPendingActionById(db, created.id);
		expect(found).not.toBeNull();
		expect(found?.user_id).toBe(userId);
	});

	it("gets actions by status", () => {
		const a1 = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-16T12:00:00Z",
		});
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-16T12:00:00Z",
		});

		updatePendingActionStatus(db, a1.id, "confirmed");

		expect(getPendingActionsByStatus(db, "pending")).toHaveLength(1);
		expect(getPendingActionsByStatus(db, "confirmed")).toHaveLength(1);
	});

	it("expires old actions", () => {
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-15T12:00:00Z", // already expired
		});
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-17T12:00:00Z", // not expired
		});

		const expired = expirePendingActions(db, "2026-03-16T00:00:00Z");
		expect(expired).toHaveLength(1);

		expect(getPendingActionsByStatus(db, "pending")).toHaveLength(1);
		expect(getPendingActionsByStatus(db, "expired")).toHaveLength(1);
	});

	it("finds pending actions for a thread", () => {
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			slackChannelId: "C123",
			slackThreadTs: "thread-1",
			expiresAt: "2026-03-17T12:00:00Z",
		});
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			slackChannelId: "C123",
			slackThreadTs: "thread-2",
			expiresAt: "2026-03-17T12:00:00Z",
		});

		const found = getPendingActionsForThread(db, userId, "C123", "thread-1");
		expect(found).toHaveLength(1);
	});

	it("checks for completed actions in thread", () => {
		const action = createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			slackChannelId: "C123",
			slackThreadTs: "thread-1",
			expiresAt: "2026-03-17T12:00:00Z",
		});

		expect(hasCompletedActionInThread(db, userId, "C123", "thread-1")).toBe(false);

		updatePendingActionStatus(db, action.id, "completed");

		expect(hasCompletedActionInThread(db, userId, "C123", "thread-1")).toBe(true);
	});

	it("cascades on user delete", () => {
		createPendingAction(db, {
			userId,
			actionType: "create_leave",
			payload: {},
			expiresAt: "2026-03-17T12:00:00Z",
		});

		db.run("DELETE FROM users WHERE id = ?", [userId]);
		expect(getPendingActionsByStatus(db, "pending")).toHaveLength(0);
	});
});

// ─── Migrations ─────────────────────────────────────────

describe("Migrations", () => {
	it("tracks applied migrations in schema_migrations table", () => {
		// Migrations already ran in beforeEach (inline runner for :memory:)
		const applied = db
			.query<{ name: string; hash: string }, []>("SELECT name, hash FROM schema_migrations ORDER BY name")
			.all();
		expect(applied.length).toBeGreaterThanOrEqual(4);
		expect(applied[0].name).toBe("001_create_users.sql");
		expect(applied[1].name).toBe("002_create_leave_records.sql");
		expect(applied[2].name).toBe("003_create_pending_actions.sql");
		expect(applied[3].name).toBe("004_add_leave_record_time_fields.sql");
		// Hashes should be non-empty SHA256
		expect(applied[0].hash.length).toBe(64);
	});

	it("is idempotent", () => {
		// Run migrations again — should be a no-op
		runMigrations(db, "./migrations");
		const applied = db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all();
		expect(applied).toHaveLength(4);
	});
});
