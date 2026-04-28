import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { openDatabase, runMigrations } from "../src/db/index.js";
import type { BotContext } from "../src/interfaces/plugin.js";
import { AdminPlugin } from "../src/plugins/admin/index.js";
import { MockAIService, MockCalendarService, MockHarvestService, MockSlackService } from "./mocks.js";

let db: Database;
let slack: MockSlackService;
let harvest: MockHarvestService;
let ctx: BotContext;

beforeEach(() => {
	db = openDatabase({ dbPath: ":memory:" });
	runMigrations(db, "./migrations");
	slack = new MockSlackService();
	harvest = new MockHarvestService();
	ctx = {
		ai: new MockAIService(),
		calendar: new MockCalendarService(),
		harvest,
		slack,
	};
});

describe("AdminPlugin", () => {
	it("syncs users via /jadoo-sync and responds ephemerally", async () => {
		slack.channelMembers.set("C_LEAVE", ["U1", "U2"]);
		slack.addUser({
			userId: "U1",
			displayName: "Alice",
			email: "alice@example.com",
			timezone: "Asia/Kolkata",
			isBot: false,
		});
		slack.addUser({ userId: "U2", displayName: "Botty", isBot: true });
		harvest.users.push({ id: 101, firstName: "Alice", lastName: "A", email: "alice@example.com", isActive: true });

		const plugin = new AdminPlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE" });

		await slack.simulateCommand({
			command: "/jadoo-sync",
			text: "",
			userId: "U_ADMIN",
			channelId: "C_LEAVE",
		});

		expect(slack.commandResponses).toHaveLength(2);
		expect(slack.commandResponses[0].options.text).toContain("⏳ Syncing users");
		expect(slack.commandResponses[1].options.text).toContain("✅ *User sync complete*");
		expect(slack.commandResponses[1].options.text).toContain("Imported: 1");
		expect(slack.commandResponses[1].options.text).toContain("Harvest linked: 1");
	});

	it("asks the user to run /jadoo-sync in the leave channel when invoked elsewhere", async () => {
		const plugin = new AdminPlugin(db);
		await plugin.init(ctx, { channelId: "C_LEAVE" });

		await slack.simulateCommand({
			command: "/jadoo-sync",
			text: "",
			userId: "U_ADMIN",
			channelId: "C_OTHER",
		});

		expect(slack.commandResponses).toHaveLength(1);
		expect(slack.commandResponses[0].options.text).toContain("configured leave channel");
	});
});
