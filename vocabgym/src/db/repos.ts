import { Database } from "@db/sqlite";

import { nowIso } from "../lib/time.ts";
import type { PasskeyCredential, SessionRecord, User, UserRole, VocabEntry } from "../types.ts";

export function findUserById(db: Database, id: string): User | null {
	return (db.prepare("SELECT * FROM users WHERE id = ?").get([id]) as User | undefined) ?? null;
}

export function findUserByUsername(db: Database, username: string): User | null {
	return (db.prepare("SELECT * FROM users WHERE username = ?").get([username]) as User | undefined) ?? null;
}

export function createUser(
	db: Database,
	input: { id: string; username: string; displayName: string; role: UserRole; passkeyResetRequired?: boolean },
): User {
	const timestamp = nowIso();
	db.prepare(
		`INSERT INTO users (id, username, display_name, role, passkey_reset_required, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run([
		input.id,
		input.username,
		input.displayName,
		input.role,
		input.passkeyResetRequired ? 1 : 0,
		timestamp,
		timestamp,
	]);
	return findUserById(db, input.id)!;
}

export function updateUserPasskeyResetRequired(db: Database, userId: string, required: boolean): void {
	db.prepare("UPDATE users SET passkey_reset_required = ?, updated_at = ? WHERE id = ?").run([
		required ? 1 : 0,
		nowIso(),
		userId,
	]);
}

export function listUsers(
	db: Database,
): Array<User & { active_credential_id: string | null; active_session_count: number }> {
	return db.prepare(
		`SELECT users.*, passkey_credentials.credential_id AS active_credential_id,
			(SELECT COUNT(*) FROM sessions WHERE sessions.user_id = users.id AND sessions.expires_at > ?) AS active_session_count
		 FROM users
		 LEFT JOIN passkey_credentials
			ON passkey_credentials.user_id = users.id AND passkey_credentials.revoked_at IS NULL
		 ORDER BY users.created_at DESC`,
	).all([nowIso()]) as Array<User & { active_credential_id: string | null; active_session_count: number }>;
}

export function findActiveCredentialByUserId(db: Database, userId: string): PasskeyCredential | null {
	return (db.prepare(
		"SELECT * FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL LIMIT 1",
	).get([userId]) as PasskeyCredential | undefined) ?? null;
}

export function findCredentialByCredentialId(db: Database, credentialId: string): PasskeyCredential | null {
	return (db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ? LIMIT 1").get([credentialId]) as
		| PasskeyCredential
		| undefined) ?? null;
}

export function replaceCredential(
	db: Database,
	input: {
		id: string;
		userId: string;
		credentialId: string;
		publicKey: string;
		counter: number;
		transportsJson: string | null;
	},
): PasskeyCredential {
	const timestamp = nowIso();
	db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").run([input.userId]);
	db.prepare(
		`INSERT INTO passkey_credentials
		 (id, user_id, credential_id, public_key, counter, transports_json, created_at, last_used_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
	).run([
		input.id,
		input.userId,
		input.credentialId,
		input.publicKey,
		input.counter,
		input.transportsJson,
		timestamp,
	]);
	return findActiveCredentialByUserId(db, input.userId)!;
}

export function updateCredentialUsage(db: Database, credentialId: string, counter: number): void {
	db.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?").run([
		counter,
		nowIso(),
		credentialId,
	]);
}

export function revokeCredentialsForUser(db: Database, userId: string): void {
	const timestamp = nowIso();
	db.prepare(
		"UPDATE passkey_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL",
	).run([timestamp, userId]);
}

export function createSession(
	db: Database,
	input: {
		id: string;
		userId: string;
		expiresAt: string;
		userAgent: string | null;
		ipHash: string | null;
	},
): SessionRecord {
	const timestamp = nowIso();
	db.prepare(
		`INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, user_agent, ip_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run([input.id, input.userId, input.expiresAt, timestamp, timestamp, input.userAgent, input.ipHash]);
	return getSession(db, input.id)!;
}

export function getSession(db: Database, id: string): SessionRecord | null {
	return (db.prepare("SELECT * FROM sessions WHERE id = ?").get([id]) as SessionRecord | undefined) ?? null;
}

export function touchSession(db: Database, id: string): void {
	db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run([nowIso(), id]);
}

export function deleteSession(db: Database, id: string): void {
	db.prepare("DELETE FROM sessions WHERE id = ?").run([id]);
}

export function deleteExpiredSessions(db: Database): void {
	db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run([nowIso()]);
}

export function deleteSessionsForUser(db: Database, userId: string): void {
	db.prepare("DELETE FROM sessions WHERE user_id = ?").run([userId]);
}

export function listVocabEntries(db: Database, userId: string): VocabEntry[] {
	return db.prepare("SELECT * FROM vocab_entries WHERE user_id = ? ORDER BY created_at DESC").all([
		userId,
	]) as VocabEntry[];
}

export function insertVocabEntry(
	db: Database,
	input: Omit<VocabEntry, "created_at"> & { created_at?: string },
): VocabEntry {
	const createdAt = input.created_at ?? nowIso();
	db.prepare(
		`INSERT INTO vocab_entries (
			id, user_id, source_term, normalized_source_term, known_language, target_language,
			part_of_speech, chosen_translation, register_label, when_to_use, explanation,
			example_target, example_known, notes_json, model_name, created_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run([
		input.id,
		input.user_id,
		input.source_term,
		input.normalized_source_term,
		input.known_language,
		input.target_language,
		input.part_of_speech,
		input.chosen_translation,
		input.register_label,
		input.when_to_use,
		input.explanation,
		input.example_target,
		input.example_known,
		input.notes_json,
		input.model_name,
		createdAt,
	]);
	return db.prepare("SELECT * FROM vocab_entries WHERE id = ?").get([input.id]) as VocabEntry;
}

export function deleteVocabEntry(db: Database, entryId: string, userId: string): boolean {
	const deleted = db.prepare("DELETE FROM vocab_entries WHERE id = ? AND user_id = ?").run([entryId, userId]);
	return deleted > 0;
}

export function createAuditLog(
	db: Database,
	input: { id: string; adminUserId: string; targetUserId: string | null; action: string; metadataJson: string },
): void {
	db.prepare(
		`INSERT INTO admin_audit_log (id, admin_user_id, target_user_id, action, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run([input.id, input.adminUserId, input.targetUserId, input.action, input.metadataJson, nowIso()]);
}
