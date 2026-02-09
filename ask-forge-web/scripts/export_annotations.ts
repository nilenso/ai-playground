#!/usr/bin/env bun
/**
 * Export annotation data from SQLite to CSV.
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";

const SCRIPT_DIR = dirname(import.meta.path);
const DB_PATH = Bun.argv[2] ?? join(SCRIPT_DIR, "..", "data", "ask-forge.db");
const OUTPUT_PATH = join(SCRIPT_DIR, "..", "data", "annotations_export.csv");

function csvEscape(value: unknown): string {
	if (value === null || value === undefined) return "";
	const str = String(value);
	if (str.includes(",") || str.includes('"') || str.includes("\n")) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

function toCsvRow(fields: unknown[]): string {
	return fields.map(csvEscape).join(",");
}

const db = new Database(DB_PATH, { readonly: true });

const rows = db
	.query(
		`
    SELECT
        s.id AS session_id,
        r.git_url AS repository,
        c.commit_id,
        s.title AS question,
        a.is_relevant AS is_answer_relevant,
        a.is_evidence_supported,
        a.is_clear AS is_clear_and_readable,
        a.feedback_text AS misc_feedback
    FROM response_annotations a
    JOIN sessions s ON s.id = a.session_id
    JOIN repositories r ON r.id = s.repository_id
    LEFT JOIN checkouts c ON c.id = s.checkout_id
    ORDER BY r.git_url, c.commit_id, s.id, a.ask_index
`,
	)
	.all() as Record<string, unknown>[];

db.close();

const header = ["session_id", "repository", "commit_id", "question", "is_answer_relevant", "is_evidence_supported", "is_clear_and_readable", "misc_feedback"];
const lines = [toCsvRow(header), ...rows.map((row) => toCsvRow(header.map((col) => row[col])))];

await Bun.write(OUTPUT_PATH, lines.join("\n") + "\n");
console.log(`Exported ${rows.length} rows to ${OUTPUT_PATH}`);
