#!/usr/bin/env bun
/**
 * Dump all sessions from the ask-forge-web database into individual JSON files.
 *
 * Usage:
 *   bun scripts/dump-sessions.ts <output-dir>
 *   bun scripts/dump-sessions.ts sessions-feb3
 *
 * Each session is written as <session-id>.json containing the session metadata,
 * user, repository, checkout, messages (ordered by ordinal), usage stats,
 * feedback, and share links.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/ask-forge.db";
const outputDir = process.argv[2];

if (!outputDir) {
	console.error("Usage: bun scripts/dump-sessions.ts <output-dir>");
	process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

mkdirSync(outputDir, { recursive: true });

const sessions = db.query("SELECT * FROM sessions").all();

if (sessions.length === 0) {
	console.log("No sessions found in database.");
	process.exit(0);
}

console.log(`Found ${sessions.length} session(s). Dumping to ${outputDir}/...`);

for (const session of sessions as any[]) {
	const user = db.query("SELECT * FROM users WHERE id = ?").get(session.user_id);

	const repository = db.query("SELECT * FROM repositories WHERE id = ?").get(session.repository_id);

	const checkout = session.checkout_id
		? db.query("SELECT * FROM checkouts WHERE id = ?").get(session.checkout_id)
		: null;

	const messages = db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal ASC").all(session.id);

	// Attach feedback and usage stats to each message
	const messagesWithDetails = (messages as any[]).map((msg) => {
		const feedback = db.query("SELECT feedback FROM message_feedback WHERE message_id = ?").get(msg.id);
		const usage = db.query("SELECT * FROM usage_stats WHERE message_id = ?").get(msg.id);

		return {
			...msg,
			feedback: feedback ? (feedback as any).feedback : null,
			usage_stats: usage || null,
		};
	});

	const shareLinks = db.query("SELECT * FROM share_links WHERE session_id = ?").all(session.id);

	const dump = {
		session,
		user,
		repository,
		checkout,
		messages: messagesWithDetails,
		share_links: shareLinks,
	};

	const filename = `${session.id}.json`;
	const filepath = join(outputDir, filename);
	writeFileSync(filepath, JSON.stringify(dump, null, 2));
	console.log(`  ${filename} (${messagesWithDetails.length} messages)`);
}

db.close();
console.log("Done.");
