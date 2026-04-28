/**
 * Jadoo — extensible Slack bot with AI and Google Calendar integrations.
 *
 * Entry point: wires up config → services → bot + worker → plugins → start.
 */

import { Bot } from "./bot.js";
import { loadAIConfig, loadGoogleCalendarConfig, loadHarvestConfig, loadSlackConfig } from "./config/index.js";
import { openDatabase, runMigrations } from "./db/index.js";
import { AdminPlugin } from "./plugins/admin/index.js";
import { LeavePlugin } from "./plugins/leave/index.js";
import { PiAIService } from "./services/ai/pi-ai-service.js";
import { GCalService } from "./services/calendar/gcal-service.js";
import { HarvestAPIService } from "./services/harvest/harvest-service.js";
import { BoltSlackService } from "./services/slack/bolt-slack-service.js";
import { BackgroundWorker } from "./worker.js";

let bot: Bot | undefined;
let worker: BackgroundWorker | undefined;
let db: ReturnType<typeof openDatabase> | undefined;

async function main(): Promise<void> {
	try {
		console.log("[jadoo] loading configuration");
		const slackConfig = loadSlackConfig();
		const aiConfig = loadAIConfig();
		const gcalConfig = loadGoogleCalendarConfig();
		const harvestConfig = loadHarvestConfig();

		console.log("[jadoo] opening database");
		db = openDatabase();
		runMigrations(db);

		console.log("[jadoo] building services");
		const slack = new BoltSlackService(slackConfig);
		const ai = new PiAIService(aiConfig);
		const calendar = new GCalService(gcalConfig);
		const harvest = new HarvestAPIService(harvestConfig);

		console.log("[jadoo] registering plugins");
		bot = new Bot({ ai, calendar, harvest, slack });
		bot.register(new AdminPlugin(db));
		bot.register(new LeavePlugin(db));

		worker = new BackgroundWorker({ db, calendar, harvest, slack });

		console.log("[jadoo] starting bot");
		await bot.start();
		worker.start();
		console.log("🚀 Jadoo is live");
	} catch (err) {
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(`[jadoo] fatal startup error: ${msg}`);

		try {
			worker?.stop();
			await bot?.stop();
			db?.close();
		} catch (cleanupErr) {
			console.error(`[jadoo] cleanup after startup failure also failed: ${cleanupErr}`);
		}

		process.exit(1);
	}
}

async function shutdown(signal: string): Promise<void> {
	console.log(`\n[jadoo] shutting down on ${signal}…`);

	try {
		worker?.stop();
		await bot?.stop();
		db?.close();
		process.exit(0);
	} catch (err) {
		console.error(`[jadoo] shutdown failed: ${err}`);
		process.exit(1);
	}
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await main();

export { bot, worker };
