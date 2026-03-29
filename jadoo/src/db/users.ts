/**
 * User repository — CRUD operations on the users table.
 */

import type { Database } from "bun:sqlite";
import type { DbUser } from "./types.js";

export function createUser(
	db: Database,
	params: {
		slackUserId: string;
		slackDisplayName: string;
		email?: string | null;
		slackTimezone?: string;
		harvestUserId?: number | null;
	},
    defaultTimezone: string = "Asia/Kolkata"
): DbUser {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO users (slack_user_id, slack_display_name, email, slack_timezone, harvest_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			params.slackUserId,
			params.slackDisplayName,
			params.email ?? null,
			params.slackTimezone ?? defaultTimezone,
			params.harvestUserId ?? null,
			now,
			now,
		],
	);

	const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
	return getUserById(db, row?.id ?? 0) as DbUser;
}

export function getUserById(db: Database, id: number): DbUser | null {
	return db.query<DbUser, [number]>("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function getUserBySlackId(db: Database, slackUserId: string): DbUser | null {
	return (
		db.query<DbUser, [string]>("SELECT * FROM users WHERE slack_user_id = ? AND is_active = 1").get(slackUserId) ?? null
	);
}

export function updateUser(
	db: Database,
	id: number,
	params: {
		slackDisplayName?: string;
		email?: string | null;
		slackTimezone?: string;
		harvestUserId?: number | null;
		isActive?: boolean;
	},
): DbUser | null {
	const fields: string[] = [];
	const values: (string | number | null)[] = [];

	if (params.slackDisplayName !== undefined) {
		fields.push("slack_display_name = ?");
		values.push(params.slackDisplayName);
	}
	if (params.email !== undefined) {
		fields.push("email = ?");
		values.push(params.email);
	}
	if (params.slackTimezone !== undefined) {
		fields.push("slack_timezone = ?");
		values.push(params.slackTimezone);
	}
	if (params.harvestUserId !== undefined) {
		fields.push("harvest_user_id = ?");
		values.push(params.harvestUserId);
	}
	if (params.isActive !== undefined) {
		fields.push("is_active = ?");
		values.push(params.isActive ? 1 : 0);
	}

	if (fields.length === 0) return getUserById(db, id);

	fields.push("updated_at = ?");
	values.push(new Date().toISOString());
	values.push(id);

	db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
	return getUserById(db, id);
}

export function listUsers(db: Database, opts?: { activeOnly?: boolean }): DbUser[] {
	if (opts?.activeOnly) {
		return db.query<DbUser, []>("SELECT * FROM users WHERE is_active = 1 ORDER BY slack_display_name").all();
	}
	return db.query<DbUser, []>("SELECT * FROM users ORDER BY slack_display_name").all();
}
