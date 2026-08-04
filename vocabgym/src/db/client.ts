import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import { Database } from "@db/sqlite";

export async function openDatabase(path: string): Promise<Database> {
	if (path !== ":memory:") {
		await ensureDir(dirname(path));
	}
	const db = new Database(path);
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA journal_mode = WAL");
	return db;
}
