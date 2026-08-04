import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { applyMigrations } from "./db/migrations.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
const db = await openDatabase(config.databasePath);
applyMigrations(db);

const app = createApp({ db, config });

console.log(`VocabGym listening on ${config.publicBaseUrl}`);
Deno.serve({ port: config.port }, app.fetch);
