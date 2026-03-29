/**
 * Jadoo — extensible Slack bot with AI and Google Calendar integrations.
 *
 * Entry point: wires up config → services → bot + worker → plugins → start.
 */

import { Bot } from "./bot.js";
import { loadConfig } from "./config/index.js";
import { openDatabase, runMigrations } from "./db/index.js";
import { PiAIService } from "./services/ai/pi-ai-service.js";
import { GCalService } from "./services/calendar/gcal-service.js";
import { HarvestAPIService } from "./services/harvest/harvest-service.js";
import { BoltSlackService } from "./services/slack/bolt-slack-service.js";
import { BackgroundWorker } from "./worker.js";
import { registerLeaveHandlers } from "./plugins/leave/leave-worker-handlers.js";

// Load configuration from TOML
const configFilePath = process.env.JADOO_CONFIG_PATH || "jadoo.example.toml";
const appConfig = loadConfig(configFilePath);

// Database
const db = openDatabase();
runMigrations(db);

// Build services
const slack = new BoltSlackService(appConfig.slack);
const ai = new PiAIService(appConfig.ai);
const calendar = new GCalService(appConfig.gcal);
const harvest = new HarvestAPIService(appConfig.harvest);

// Plugin Configs Map
const pluginConfigs: Record<string, any> = {};
if (appConfig.plugins) {
    for (const p of appConfig.plugins) {
        pluginConfigs[p.name] = p.config || {};
    }
}

// Assemble bot
const bot = new Bot({ ai, calendar, harvest, slack }, { pluginConfigs });

// Background worker — processes confirmed actions + expires stale ones
const worker = new BackgroundWorker({ db, calendar, harvest, slack });

// Register plugins and their specific worker handlers here
if (pluginConfigs["leave"]) {
    // bot.register(new LeavePlugin()); // Example: uncomment when LeavePlugin is implemented
    registerLeaveHandlers(worker, db, {
        vacationTaskId: pluginConfigs["leave"].harvestVacationTaskId,
        sickTaskId: pluginConfigs["leave"].harvestSickTaskId,
        projectId: pluginConfigs["leave"].harvestProjectId,
    }, calendar, harvest, slack);
}

await bot.start();
worker.start();
console.log(`🚀 Jadoo is live (Port: ${appConfig.app?.port || 3000})`);

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
