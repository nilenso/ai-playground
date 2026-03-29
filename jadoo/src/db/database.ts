/**
 * SQLite database setup.
 *
 * Uses bun:sqlite for zero-dependency SQLite access.
 * Migrations are managed by litem8 (external binary).
 */

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_DB_PATH = "./data/jadoo.db";
const DEFAULT_MIGRATIONS_DIR = "./migrations";

export interface DatabaseOptions {
	/** Path to the SQLite database file. Use ":memory:" for in-memory. */
	dbPath?: string;
	/** Path to the migrations directory. */
	migrationsDir?: string;
}

/**
 * Open (or create) a database with standard pragmas.
 */
export function openDatabase(options?: DatabaseOptions): Database {
	const dbPath = options?.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;

	if (dbPath !== ":memory:") {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");

	return db;
}

/**
 * Run pending migrations using litem8.
 *
 * For production/dev: calls litem8 binary against a file-based DB.
 * For tests: applies migrations directly using bun:sqlite (since litem8 can't target :memory:).
 */
export function runMigrations(db: Database, migrationsDir?: string): void {
	const dir = resolve(migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
	const filename = db.filename;

	if (filename === "" || filename === ":memory:") {
		// In-memory DB — litem8 can't reach it, so apply migrations inline
		applyMigrationsInline(db, dir);
		return;
	}

	// File-based DB — use litem8
	try {
		execSync(`litem8 up --db ${JSON.stringify(filename)} --migrations ${JSON.stringify(dir)}`, {
			stdio: "inherit",
		});
	} catch (e) {
		throw new Error(`litem8 migration failed: ${e}`);
	}
}

/**
 * Inline migration runner for in-memory databases (tests).
 * Mimics litem8's schema_migrations table so the schema is consistent.
 */
function applyMigrationsInline(db: Database, migrationsDir: string): void {
	const { readdirSync, readFileSync } = require("node:fs");
	const { join } = require("node:path");

	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			hash TEXT NOT NULL,
			migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const applied = new Set(
		db
			.query<{ name: string }, []>("SELECT name FROM schema_migrations")
			.all()
			.map((r) => r.name),
	);

	if (!existsSync(migrationsDir)) return;

	const files = (readdirSync(migrationsDir) as string[]).filter((f: string) => f.endsWith(".sql")).sort();

	for (const file of files) {
		if (applied.has(file)) continue;

		const sql = readFileSync(join(migrationsDir, file), "utf-8") as string;
		const hash = new Bun.CryptoHasher("sha256").update(sql).digest("hex");

		db.transaction(() => {
			db.exec(sql);
			db.run("INSERT INTO schema_migrations (name, hash) VALUES (?, ?)", [file, hash]);
		})();
	}
}
