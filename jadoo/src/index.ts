/**
 * Jadoo — extensible Slack bot with AI and Google Calendar integrations.
 *
 * Entry point: wires up config → services → bot + worker → plugins → start.
 */

import { Bot } from "./bot.js";
import { loadAIConfig, loadGoogleCalendarConfig, loadHarvestConfig, loadSlackConfig } from "./config/index.js";
import { openDatabase, runMigrations } from "./db/index.js";
import { PiAIService } from "./services/ai/pi-ai-service.js";
import { GCalService } from "./services/calendar/gcal-service.js";
import { HarvestAPIService } from "./services/harvest/harvest-service.js";
import { BoltSlackService } from "./services/slack/bolt-slack-service.js";
import { BackgroundWorker } from "./worker.js";

// Load configuration from environment
const slackConfig = loadSlackConfig();
const aiConfig = loadAIConfig();
const gcalConfig = loadGoogleCalendarConfig();
const harvestConfig = loadHarvestConfig();

// Database
const db = openDatabase();
runMigrations(db);

// Build services
const slack = new BoltSlackService(slackConfig);
const ai = new PiAIService(aiConfig);
const calendar = new GCalService(gcalConfig);
const harvest = new HarvestAPIService(harvestConfig);

import { AdminPlugin } from "./plugins/admin/index.js";
import { LeavePlugin } from "./plugins/leave/index.js";

// Assemble bot
const bot = new Bot({ ai, calendar, harvest, slack });

// Register plugins here:
bot.register(new AdminPlugin(db));
bot.register(new LeavePlugin(db));

// Background worker — processes confirmed leave actions + expires stale ones
const worker = new BackgroundWorker({ db, calendar, harvest, slack });

await bot.start();
worker.start();
console.log("🚀 Jadoo is live");

// Graceful shutdown
function shutdown() {
	console.log("\n[jadoo] shutting down…");
	worker.stop();
	bot.stop();
	db.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { bot, worker };
