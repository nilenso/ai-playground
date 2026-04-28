#!/usr/bin/env bun
/**
 * Dump all sessions from the megasthenes-web database into pi-compatible JSONL files.
 *
 * Usage:
 *   bun scripts/dump-sessions.ts <output-dir>
 *   bun scripts/dump-sessions.ts sessions-feb3
 *
 * Each session is written as {timestamp}_{session-id}.jsonl in pi session format:
 * - Line 1: SessionHeader (type: "session", version, id, timestamp, cwd)
 * - Subsequent lines: SessionEntry with id, parentId, timestamp, and type-specific fields
 *
 * Pi session format uses a tree structure where each entry has an id and parentId,
 * forming a linked list (or tree for branched sessions).
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/megasthenes.db";
const outputDir = process.argv[2];

// Current pi session format version
const SESSION_VERSION = 3;

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

/** Generate a short ID (8 hex chars) for entry IDs */
function generateId(): string {
	return randomUUID().slice(0, 8);
}

for (const session of sessions as any[]) {
	const messages = db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal ASC").all(session.id);
	const repository = db.query("SELECT * FROM repositories WHERE id = ?").get(session.repository_id) as any;
	const compactions = db
		.query("SELECT * FROM compactions WHERE session_id = ? ORDER BY created_at ASC")
		.all(session.id) as any[];

	// Build a map of ordinal -> compaction (compaction applies BEFORE messages at first_kept_ordinal)
	const compactionByFirstKeptOrdinal = new Map<number, any>();
	for (const c of compactions) {
		compactionByFirstKeptOrdinal.set(c.first_kept_ordinal, c);
	}

	const lines: string[] = [];
	const sessionTimestamp = new Date(session.created_at).toISOString();

	// Construct cwd from repository info
	const cwd = repository ? `/checkouts/${repository.username_or_organization}/${repository.repository_name}` : "/";

	// Session header (first line)
	const header = {
		type: "session",
		version: SESSION_VERSION,
		id: session.id,
		timestamp: sessionTimestamp,
		cwd,
	};
	lines.push(JSON.stringify(header));

	// Track parent ID for tree structure (linear chain in this case)
	let parentId: string | null = null;

	// Track entry IDs by ordinal for compaction's firstKeptEntryId reference
	const entryIdByOrdinal = new Map<number, string>();

	// Convert each message to pi format SessionEntry
	for (const msg of messages as any[]) {
		const entryId = generateId();
		const msgTimestamp = new Date(msg.created_at).toISOString();

		// Store entry ID for this ordinal (needed for compaction's firstKeptEntryId)
		entryIdByOrdinal.set(msg.ordinal, entryId);

		// Check if there's a compaction that applies before this message
		const compaction = compactionByFirstKeptOrdinal.get(msg.ordinal);
		if (compaction) {
			const compactionEntryId = generateId();
			const compactionTimestamp = new Date(compaction.created_at).toISOString();

			const compactionEntry = {
				type: "compaction",
				id: compactionEntryId,
				parentId,
				timestamp: compactionTimestamp,
				summary: compaction.summary,
				firstKeptEntryId: entryId, // Points to the message entry we're about to emit
				tokensBefore: compaction.tokens_before || 0,
				details: {
					readFiles: compaction.read_files ? JSON.parse(compaction.read_files) : [],
					modifiedFiles: compaction.modified_files ? JSON.parse(compaction.modified_files) : [],
				},
			};
			lines.push(JSON.stringify(compactionEntry));
			parentId = compactionEntryId;
		}

		if (msg.role === "user") {
			// User message entry
			const entry = {
				type: "message",
				id: entryId,
				parentId,
				timestamp: msgTimestamp,
				message: {
					role: "user",
					content: [{ type: "text", text: msg.content }],
					timestamp: new Date(msg.created_at).getTime(),
				},
			};
			lines.push(JSON.stringify(entry));
			parentId = entryId;
		} else if (msg.role === "assistant") {
			// Assistant message - content is already JSON array of content blocks
			let content: any[];
			try {
				content = JSON.parse(msg.content);
			} catch {
				content = [{ type: "text", text: msg.content }];
			}

			// Get usage stats if available
			const usage = db.query("SELECT * FROM usage_stats WHERE message_id = ?").get(msg.id) as any;

			// Determine stopReason based on whether there are tool calls
			const hasToolCalls = content.some((block: any) => block.type === "toolCall");
			const stopReason = hasToolCalls ? "toolUse" : "stop";

			const entry = {
				type: "message",
				id: entryId,
				parentId,
				timestamp: msgTimestamp,
				message: {
					role: "assistant",
					content,
					api: "anthropic-messages" as const,
					provider: "anthropic",
					model: "claude-sonnet-4-20250514", // Default, we don't store this in DB
					usage: usage
						? {
								input: usage.input_tokens || 0,
								output: usage.output_tokens || 0,
								cacheRead: usage.cache_read_tokens || 0,
								cacheWrite: usage.cache_write_tokens || 0,
								totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
								cost: {
									input: usage.input_cost || 0,
									output: usage.output_cost || 0,
									cacheRead: usage.cache_read_cost || 0,
									cacheWrite: usage.cache_write_cost || 0,
									total: usage.total_cost || 0,
								},
							}
						: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
					stopReason,
					timestamp: new Date(msg.created_at).getTime(),
				},
			};
			lines.push(JSON.stringify(entry));
			parentId = entryId;
		} else if (msg.role === "tool") {
			// Tool result message entry
			const entry = {
				type: "message",
				id: entryId,
				parentId,
				timestamp: msgTimestamp,
				message: {
					role: "toolResult",
					toolCallId: msg.tool_arguments, // tool_arguments stores the tool call ID
					toolName: msg.tool_name,
					content: [{ type: "text", text: msg.tool_result || msg.content }],
					isError: false,
					timestamp: new Date(msg.created_at).getTime(),
				},
			};
			lines.push(JSON.stringify(entry));
			parentId = entryId;
		}
	}

	// Generate filename in pi format: {timestamp}_{session-id}.jsonl
	// Convert timestamp to filename-safe format: 2025-12-25T08-26-00-961Z
	const filenameTimestamp = sessionTimestamp.replace(/:/g, "-").replace(/\./g, "-");
	const filename = `${filenameTimestamp}_${session.id}.jsonl`;
	const filepath = join(outputDir, filename);

	writeFileSync(filepath, lines.join("\n") + "\n");
	console.log(`  ${filename} (${messages.length} messages)`);
}

db.close();
console.log("Done.");
