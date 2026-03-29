/**
 * Pending action repository — CRUD operations on the pending_actions table.
 */

import type { Database } from "bun:sqlite";
import type { DbPendingAction } from "./types.js";

function generateId(): string {
	return crypto.randomUUID().slice(0, 8);
}

export function createPendingAction(
	db: Database,
	params: {
		userId: number;
		actionType: string;
		payload: Record<string, unknown>;
		slackEventId?: string | null;
		slackMessageTs?: string | null;
		slackChannelId?: string | null;
		slackThreadTs?: string | null;
		expiresAt: string;
	},
): DbPendingAction {
	const id = generateId();

	db.run(
		`INSERT INTO pending_actions (id, user_id, action_type, payload, slack_event_id, slack_message_ts, slack_channel_id, slack_thread_ts, status, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
		[
			id,
			params.userId,
			params.actionType,
			JSON.stringify(params.payload),
			params.slackEventId ?? null,
			params.slackMessageTs ?? null,
			params.slackChannelId ?? null,
			params.slackThreadTs ?? null,
			params.expiresAt,
		],
	);

	return getPendingActionById(db, id) as DbPendingAction;
}

export function getPendingActionById(db: Database, id: string): DbPendingAction | null {
	return db.query<DbPendingAction, [string]>("SELECT * FROM pending_actions WHERE id = ?").get(id) ?? null;
}

export function getPendingActionsByStatus(db: Database, status: string): DbPendingAction[] {
	return db
		.query<DbPendingAction, [string]>("SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at")
		.all(status);
}

export function updatePendingActionStatus(db: Database, id: string, status: string): void {
	db.run("UPDATE pending_actions SET status = ? WHERE id = ?", [status, id]);
}

export function updatePendingActionBotMessageTs(db: Database, id: string, botMessageTs: string): void {
	db.run("UPDATE pending_actions SET slack_bot_message_ts = ? WHERE id = ?", [botMessageTs, id]);
}

export function expirePendingActions(db: Database, now: string): DbPendingAction[] {
	const expired = db
		.query<DbPendingAction, [string]>("SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at < ?")
		.all(now);

	if (expired.length > 0) {
		db.run("UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", [now]);
	}

	return expired;
}

export function getPendingActionsForThread(
	db: Database,
	userId: number,
	channelId: string,
	threadTs: string | null,
): DbPendingAction[] {
	if (threadTs) {
		return db
			.query<DbPendingAction, [number, string, string, string]>(
				`SELECT * FROM pending_actions
			 WHERE user_id = ? AND slack_channel_id = ? AND status = 'pending'
			 AND (slack_thread_ts = ? OR slack_message_ts = ?)`,
			)
			.all(userId, channelId, threadTs, threadTs);
	}
	return db
		.query<DbPendingAction, [number, string]>(
			`SELECT * FROM pending_actions
		 WHERE user_id = ? AND slack_channel_id = ? AND status = 'pending'
		 AND slack_thread_ts IS NULL`,
		)
		.all(userId, channelId);
}

/**
 * Atomically claim all confirmed actions for processing.
 * Transitions status from 'confirmed' → 'processing' and returns the claimed rows.
 * This is safe under concurrent access because SQLite serializes writes.
 */
export function claimConfirmedActions(db: Database): DbPendingAction[] {
	return db.transaction(() => {
		const actions = db
			.query<DbPendingAction, []>("SELECT * FROM pending_actions WHERE status = 'confirmed' ORDER BY created_at")
			.all();

		if (actions.length > 0) {
			db.run("UPDATE pending_actions SET status = 'processing' WHERE status = 'confirmed'");
		}

		return actions;
	})();
}

export function hasCompletedActionInThread(db: Database, userId: number, channelId: string, threadTs: string): boolean {
	const row = db
		.query<{ count: number }, [number, string, string, string]>(
			`SELECT COUNT(*) as count FROM pending_actions
		 WHERE user_id = ? AND slack_channel_id = ?
		 AND (slack_thread_ts = ? OR slack_message_ts = ?)
		 AND status IN ('confirmed', 'completed')`,
		)
		.get(userId, channelId, threadTs, threadTs);
	return (row?.count ?? 0) > 0;
}
