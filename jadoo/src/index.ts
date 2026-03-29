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
import { createWebServer } from "./web/index.js";

// Load configuration from TOML
const configFilePath = process.env.JADOO_CONFIG_PATH;
if (!configFilePath) {
    throw new Error("Missing JADOO_CONFIG_PATH environment variable");
}
const appConfig = loadConfig(configFilePath);

// Database
const db = openDatabase();
runMigrations(db);

// Build services
const slack = new BoltSlackService(appConfig.slack);
const ai = new PiAIService(appConfig.ai);
const calendar = new GCalService(appConfig.gcal);
const harvest = new HarvestAPIService(appConfig.harvest);

// Background worker — processes confirmed actions + expires stale ones
const worker = new BackgroundWorker({ db, calendar, harvest, slack });

// Plugin Configs Map (using array indices to allow multiple instances)
const pluginConfigs: Record<string, any> = {};
if (appConfig.plugins) {
    appConfig.plugins.forEach((p, index) => {
        const uniqueKey = `${p.name}_${index}`;
        pluginConfigs[uniqueKey] = p.config || {};

        if (p.name === "leave") {
            registerLeaveHandlers(worker, db, {
                vacationTaskId: p.config?.harvestVacationTaskId,
                sickTaskId: p.config?.harvestSickTaskId,
                projectId: p.config?.harvestProjectId,
            }, calendar, harvest, slack);
        }
    });
}

// Assemble bot
const bot = new Bot({ ai, calendar, harvest, slack }, { pluginConfigs });

await bot.start();
worker.start();

// Simple Web Server
const port = appConfig.app?.port || 3000;
const app = createWebServer(db);
const server = Bun.serve({
	port,
	fetch: app.fetch,
});

console.log(`🚀 Jadoo is live (Port: ${server.port})`);

// Graceful shutdown
function shutdown() {
	console.log("\n[jadoo] shutting down…");
	server.stop();
	worker.stop();
	bot.stop();
	db.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { bot, worker, server };
