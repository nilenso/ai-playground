import { assert, assertEquals, assertThrows } from "@std/assert";
import * as v from "valibot";
import { Database } from "@db/sqlite";

import { applyMigrations } from "./db/migrations.ts";
import {
	createAuditLog,
	createSession,
	createUser,
	deleteSessionsForUser,
	findActiveCredentialByUserId,
	findUserById,
	insertVocabEntry,
	replaceCredential,
	revokeCredentialsForUser,
	updateUserPasskeyResetRequired,
} from "./db/repos.ts";
import { searchRequestSchema } from "./validation.ts";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	applyMigrations(db);
	return db;
}

Deno.test("search validation rejects identical language pairs", () => {
	const result = v.safeParse(searchRequestSchema, {
		term: "run",
		knownLanguage: "en",
		targetLanguage: "en",
	});

	assertEquals(result.success, false);
});

Deno.test("vocab uniqueness blocks exact duplicates while allowing nuanced alternatives", () => {
	const db = makeDb();
	try {
		const user = createUser(db, {
			id: "user-1",
			username: "alice",
			displayName: "Alice",
			role: "user",
		});

		insertVocabEntry(db, {
			id: "entry-1",
			user_id: user.id,
			source_term: "run",
			normalized_source_term: "run",
			known_language: "en",
			target_language: "pt-BR",
			part_of_speech: "verb",
			chosen_translation: "correr",
			register_label: "neutral",
			when_to_use: "Use for physical movement.",
			explanation: "Movement on foot at speed.",
			example_target: "Eu gosto de correr.",
			example_known: "I like to run.",
			notes_json: JSON.stringify(["Not for running a company."]),
			model_name: "openrouter/mistralai/mistral-small-2603",
		});

		assertThrows(() => {
			insertVocabEntry(db, {
				id: "entry-2",
				user_id: user.id,
				source_term: "run",
				normalized_source_term: "run",
				known_language: "en",
				target_language: "pt-BR",
				part_of_speech: "verb",
				chosen_translation: "correr",
				register_label: "neutral",
				when_to_use: "Use for physical movement.",
				explanation: "Movement on foot at speed.",
				example_target: "Eu gosto de correr.",
				example_known: "I like to run.",
				notes_json: JSON.stringify(["Duplicate entry."]),
				model_name: "openrouter/mistralai/mistral-small-2603",
			});
		});

		const alternative = insertVocabEntry(db, {
			id: "entry-3",
			user_id: user.id,
			source_term: "run",
			normalized_source_term: "run",
			known_language: "en",
			target_language: "pt-BR",
			part_of_speech: "verb",
			chosen_translation: "administrar",
			register_label: "business",
			when_to_use: "Use for running a company.",
			explanation: "Manage or operate something.",
			example_target: "Ela administra a empresa.",
			example_known: "She runs the company.",
			notes_json: JSON.stringify(["Different sense."]),
			model_name: "openrouter/mistralai/mistral-small-2603",
		});

		assertEquals(alternative.chosen_translation, "administrar");
	} finally {
		db.close();
	}
});

Deno.test("admin reset revokes passkeys, clears sessions, and logs the action", () => {
	const db = makeDb();
	try {
		const admin = createUser(db, {
			id: "admin-1",
			username: "admin",
			displayName: "Admin",
			role: "admin",
		});
		const user = createUser(db, {
			id: "user-2",
			username: "bob",
			displayName: "Bob",
			role: "user",
		});
		replaceCredential(db, {
			id: "cred-1",
			userId: user.id,
			credentialId: "credential-id",
			publicKey: "public-key",
			counter: 0,
			transportsJson: JSON.stringify(["internal"]),
		});
		createSession(db, {
			id: "session-1",
			userId: user.id,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			userAgent: "test",
			ipHash: null,
		});

		revokeCredentialsForUser(db, user.id);
		updateUserPasskeyResetRequired(db, user.id, true);
		deleteSessionsForUser(db, user.id);
		createAuditLog(db, {
			id: "audit-1",
			adminUserId: admin.id,
			targetUserId: user.id,
			action: "reset-passkey",
			metadataJson: JSON.stringify({ username: user.username }),
		});

		assertEquals(findActiveCredentialByUserId(db, user.id), null);
		assertEquals(findUserById(db, user.id)?.passkey_reset_required, 1);
		assertEquals(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get([user.id])?.count, 0);
		assertEquals(
			db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE target_user_id = ?").get([user.id])?.count,
			1,
		);
		assert(db.prepare("SELECT revoked_at FROM passkey_credentials WHERE user_id = ?").get([user.id])?.revoked_at);
	} finally {
		db.close();
	}
});
