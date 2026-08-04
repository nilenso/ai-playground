import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrations.ts";

const config = loadConfig();
const db = await openDatabase(config.databasePath);

try {
	applyMigrations(db);
	console.log(`Applied migrations to ${config.databasePath}`);
} finally {
	db.close();
}
