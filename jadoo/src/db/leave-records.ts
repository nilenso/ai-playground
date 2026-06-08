/**
 * Leave record repository — CRUD operations on the leave_records table.
 */

import type { Database } from "bun:sqlite";
import type { DbLeaveRecord } from "./types.js";

export function createLeaveRecord(
	db: Database,
	params: {
		userId: number;
		date: string;
		leaveType?: string;
		startTime?: string | null;
		endTime?: string | null;
		leaveCategory?: string;
		slackMessageTs?: string | null;
		slackChannelId?: string | null;
		status?: string;
	},
): DbLeaveRecord {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO leave_records (
			user_id,
			date,
			leave_type,
			start_time,
			end_time,
			leave_category,
			slack_message_ts,
			slack_channel_id,
			status,
			created_at,
			updated_at
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.userId,
			params.date,
			params.leaveType ?? "full",
			params.startTime ?? null,
			params.endTime ?? null,
			params.leaveCategory ?? "vacation",
			params.slackMessageTs ?? null,
			params.slackChannelId ?? null,
			params.status ?? "pending",
			now,
			now,
		],
	);

	const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
	return getLeaveRecordById(db, row?.id ?? 0) as DbLeaveRecord;
}

export function upsertLeaveRecord(
	db: Database,
	params: {
		userId: number;
		date: string;
		leaveType?: string;
		startTime?: string | null;
		endTime?: string | null;
		leaveCategory?: string;
		slackMessageTs?: string | null;
		slackChannelId?: string | null;
		status?: string;
	},
): DbLeaveRecord {
	const now = new Date().toISOString();
	const _result = db.run(
		`INSERT INTO leave_records (
			user_id,
			date,
			leave_type,
			start_time,
			end_time,
			leave_category,
			slack_message_ts,
			slack_channel_id,
			status,
			created_at,
			updated_at
		)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, date) DO UPDATE SET
		   leave_type = excluded.leave_type,
		   start_time = excluded.start_time,
		   end_time = excluded.end_time,
		   leave_category = excluded.leave_category,
		   status = excluded.status,
		   error_message = NULL,
		   updated_at = excluded.updated_at`,
		[
			params.userId,
			params.date,
			params.leaveType ?? "full",
			params.startTime ?? null,
			params.endTime ?? null,
			params.leaveCategory ?? "vacation",
			params.slackMessageTs ?? null,
			params.slackChannelId ?? null,
			params.status ?? "confirmed",
			now,
			now,
		],
	);

	// ON CONFLICT doesn't return lastInsertRowid reliably, so query by unique key
	return db
		.query<DbLeaveRecord, [number, string]>("SELECT * FROM leave_records WHERE user_id = ? AND date = ?")
		.get(params.userId, params.date) as DbLeaveRecord;
}

export function getLeaveRecordById(db: Database, id: number): DbLeaveRecord | null {
	return db.query<DbLeaveRecord, [number]>("SELECT * FROM leave_records WHERE id = ?").get(id) ?? null;
}

export function getLeaveRecordsByUserAndDates(db: Database, userId: number, dates: string[]): DbLeaveRecord[] {
	if (dates.length === 0) return [];
	const placeholders = dates.map(() => "?").join(", ");
	return db
		.query<DbLeaveRecord, (number | string)[]>(
			`SELECT * FROM leave_records
		 WHERE user_id = ? AND date IN (${placeholders})
		 AND status IN ('pending', 'confirmed')`,
		)
		.all(userId, ...dates);
}

export function getLeaveRecordsByStatus(db: Database, status: string): DbLeaveRecord[] {
	return db.query<DbLeaveRecord, [string]>("SELECT * FROM leave_records WHERE status = ?").all(status);
}

export function updateLeaveRecordStatus(
	db: Database,
	id: number,
	params: {
		status: string;
		calendarEventId?: string | null;
		harvestEntryId?: number | null;
		errorMessage?: string | null;
	},
): void {
	const fields = ["status = ?", "updated_at = ?"];
	const values: (string | number | null)[] = [params.status, new Date().toISOString()];

	if (params.calendarEventId !== undefined) {
		fields.push("calendar_event_id = ?");
		values.push(params.calendarEventId);
	}
	if (params.harvestEntryId !== undefined) {
		fields.push("harvest_entry_id = ?");
		values.push(params.harvestEntryId);
	}
	if (params.errorMessage !== undefined) {
		fields.push("error_message = ?");
		values.push(params.errorMessage);
	}

	values.push(id);
	db.run(`UPDATE leave_records SET ${fields.join(", ")} WHERE id = ?`, values);
}

/**
 * Increment the retry count and update error message.
 * Returns the new retry_count.
 */
export function incrementLeaveRecordRetry(db: Database, id: number, errorMessage: string): number {
	db.run("UPDATE leave_records SET retry_count = retry_count + 1, error_message = ?, updated_at = ? WHERE id = ?", [
		errorMessage,
		new Date().toISOString(),
		id,
	]);
	const row = db.query<{ retry_count: number }, [number]>("SELECT retry_count FROM leave_records WHERE id = ?").get(id);
	return row?.retry_count ?? 0;
}

/**
 * Get leave records associated with a pending action's user and dates.
 */
export function getLeaveRecordsByPendingAction(db: Database, userId: number, dates: string[]): DbLeaveRecord[] {
	if (dates.length === 0) return [];
	const placeholders = dates.map(() => "?").join(", ");
	return db
		.query<DbLeaveRecord, (number | string)[]>(
			`SELECT * FROM leave_records WHERE user_id = ? AND date IN (${placeholders}) ORDER BY date`,
		)
		.all(userId, ...dates);
}

export function getCancelableLeaveRecordsByUser(
	db: Database,
	userId: number,
	pivotDate: string,
	limit: number = 5,
): DbLeaveRecord[] {
	return db
		.query<DbLeaveRecord, [number, string, number]>(
			`SELECT * FROM leave_records
			 WHERE user_id = ?
			 AND status IN ('confirmed', 'completed')
			 ORDER BY CASE WHEN date >= ? THEN 0 ELSE 1 END, date ASC
			 LIMIT ?`,
		)
		.all(userId, pivotDate, limit);
}
