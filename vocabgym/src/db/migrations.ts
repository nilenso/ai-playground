import { join } from "@std/path";
import { Database } from "@db/sqlite";

export function applyMigrations(db: Database, migrationsDir = join(Deno.cwd(), "migrations")): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		)
	`);

	const applied = new Set(
		db.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => String(row.name)),
	);

	const files = [...Deno.readDirSync(migrationsDir)]
		.filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
		.map((entry) => entry.name)
		.sort();

	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}

		const sql = Deno.readTextFileSync(join(migrationsDir, file));
		db.exec("BEGIN");
		try {
			db.exec(sql);
			db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run([file, new Date().toISOString()]);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
