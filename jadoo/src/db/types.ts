/**
 * Database row types.
 * These match the SQLite schema 1:1 — no transformation.
 */

export interface DbUser {
	id: number;
	slack_user_id: string;
	slack_display_name: string;
	email: string | null;
	slack_timezone: string;
	harvest_user_id: number | null;
	is_active: number; // SQLite boolean: 0 or 1
	created_at: string;
	updated_at: string;
}

export interface DbLeaveRecord {
	id: number;
	user_id: number;
	date: string; // YYYY-MM-DD
	leave_type: string; // 'full' | 'half_am' | 'half_pm'
	leave_category: string; // 'vacation' | 'sick'
	slack_message_ts: string | null;
	slack_channel_id: string | null;
	calendar_event_id: string | null;
	harvest_entry_id: number | null;
	status: string; // 'pending' | 'confirmed' | 'completed' | 'failed' | 'cancelled'
	error_message: string | null;
	retry_count: number;
	created_at: string;
	updated_at: string;
}

export interface DbPendingAction {
	id: string;
	user_id: number;
	action_type: string; // 'create_leave' | 'cancel_leave'
	payload: string; // JSON string
	slack_event_id: string | null;
	slack_message_ts: string | null;
	slack_channel_id: string | null;
	slack_thread_ts: string | null;
	slack_bot_message_ts: string | null;
	status: string; // 'pending' | 'confirmed' | 'processing' | 'completed' | 'expired' | 'cancelled'
	expires_at: string;
	created_at: string;
}
