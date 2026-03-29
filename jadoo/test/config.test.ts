import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	loadAIConfig,
	loadGoogleCalendarConfig,
	loadHarvestConfig,
	loadSlackConfig,
	parseServiceAccountJson,
} from "../src/config/index.js";

describe("Config loading", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Clean slate
		for (const key of Object.keys(process.env)) {
			if (
				key.startsWith("SLACK_") ||
				key.startsWith("AI_") ||
				key.startsWith("GOOGLE_") ||
				key.startsWith("HARVEST_")
			) {
				delete process.env[key];
			}
		}
	});

	afterEach(() => {
		// Restore
		Object.assign(process.env, originalEnv);
	});

	describe("loadSlackConfig", () => {
		it("loads required slack config", () => {
			process.env.SLACK_BOT_TOKEN = "xoxb-test";
			process.env.SLACK_SIGNING_SECRET = "secret";
			process.env.SLACK_APP_TOKEN = "xapp-test";

			const config = loadSlackConfig();
			expect(config.botToken).toBe("xoxb-test");
			expect(config.signingSecret).toBe("secret");
			expect(config.appToken).toBe("xapp-test");
			expect(config.port).toBeUndefined();
		});

		it("throws on missing required field", () => {
			expect(() => loadSlackConfig()).toThrow("SLACK_BOT_TOKEN");
		});

		it("parses optional port", () => {
			process.env.SLACK_BOT_TOKEN = "xoxb-test";
			process.env.SLACK_SIGNING_SECRET = "secret";
			process.env.SLACK_APP_TOKEN = "xapp-test";
			process.env.SLACK_PORT = "3001";

			const config = loadSlackConfig();
			expect(config.port).toBe(3001);
		});
	});

	describe("loadAIConfig", () => {
		it("loads required AI config", () => {
			process.env.AI_PROVIDER = "anthropic";
			process.env.AI_MODEL = "claude-sonnet-4-20250514";
			process.env.AI_API_KEY = "sk-test";

			const config = loadAIConfig();
			expect(config.provider).toBe("anthropic");
			expect(config.model).toBe("claude-sonnet-4-20250514");
			expect(config.apiKey).toBe("sk-test");
		});

		it("throws on missing API key", () => {
			process.env.AI_PROVIDER = "anthropic";
			process.env.AI_MODEL = "claude-sonnet-4-20250514";
			expect(() => loadAIConfig()).toThrow("AI_API_KEY");
		});
	});

	describe("loadGoogleCalendarConfig", () => {
		it("loads from individual fields", () => {
			process.env.GOOGLE_CLIENT_EMAIL = "bot@test.iam.gserviceaccount.com";
			process.env.GOOGLE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
			process.env.GOOGLE_CALENDAR_ID = "cal@group.calendar.google.com";

			const config = loadGoogleCalendarConfig();
			expect(config.clientEmail).toBe("bot@test.iam.gserviceaccount.com");
			expect(config.privateKey).toBe("-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----");
			expect(config.calendarId).toBe("cal@group.calendar.google.com");
		});

		it("loads from base64 service account JSON", () => {
			const serviceAccount = {
				type: "service_account",
				client_email: "bot@my-project.iam.gserviceaccount.com",
				private_key: "-----BEGIN PRIVATE KEY-----\nbase64key\n-----END PRIVATE KEY-----\n",
				project_id: "my-project",
			};
			process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = btoa(JSON.stringify(serviceAccount));
			process.env.GOOGLE_CALENDAR_ID = "cal@group.calendar.google.com";

			const config = loadGoogleCalendarConfig();
			expect(config.clientEmail).toBe("bot@my-project.iam.gserviceaccount.com");
			expect(config.privateKey).toBe("-----BEGIN PRIVATE KEY-----\nbase64key\n-----END PRIVATE KEY-----\n");
			expect(config.calendarId).toBe("cal@group.calendar.google.com");
		});

		it("base64 JSON takes precedence over individual fields", () => {
			const serviceAccount = {
				client_email: "from-json@test.iam.gserviceaccount.com",
				private_key: "json-key",
			};
			process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = btoa(JSON.stringify(serviceAccount));
			process.env.GOOGLE_CLIENT_EMAIL = "from-env@test.iam.gserviceaccount.com";
			process.env.GOOGLE_PRIVATE_KEY = "env-key";
			process.env.GOOGLE_CALENDAR_ID = "cal@group.calendar.google.com";

			const config = loadGoogleCalendarConfig();
			expect(config.clientEmail).toBe("from-json@test.iam.gserviceaccount.com");
			expect(config.privateKey).toBe("json-key");
		});

		it("throws when GOOGLE_CALENDAR_ID is missing", () => {
			process.env.GOOGLE_CLIENT_EMAIL = "bot@test.iam.gserviceaccount.com";
			process.env.GOOGLE_PRIVATE_KEY = "key";
			expect(() => loadGoogleCalendarConfig()).toThrow("GOOGLE_CALENDAR_ID");
		});

		it("throws when neither auth format is provided", () => {
			process.env.GOOGLE_CALENDAR_ID = "cal@group.calendar.google.com";
			expect(() => loadGoogleCalendarConfig()).toThrow("GOOGLE_CLIENT_EMAIL");
		});
	});

	describe("parseServiceAccountJson", () => {
		it("extracts client_email and private_key from base64 JSON", () => {
			const json = { client_email: "a@b.com", private_key: "pk" };
			const config = parseServiceAccountJson(btoa(JSON.stringify(json)), "cal-id");
			expect(config.clientEmail).toBe("a@b.com");
			expect(config.privateKey).toBe("pk");
			expect(config.calendarId).toBe("cal-id");
		});

		it("throws on invalid base64", () => {
			expect(() => parseServiceAccountJson("not!valid!base64!!!", "cal")).toThrow("not valid base64");
		});

		it("throws on valid base64 but invalid JSON", () => {
			expect(() => parseServiceAccountJson(btoa("not json"), "cal")).toThrow("does not contain valid JSON");
		});

		it("throws when client_email is missing", () => {
			const json = { private_key: "pk" };
			expect(() => parseServiceAccountJson(btoa(JSON.stringify(json)), "cal")).toThrow("client_email");
		});

		it("throws when private_key is missing", () => {
			const json = { client_email: "a@b.com" };
			expect(() => parseServiceAccountJson(btoa(JSON.stringify(json)), "cal")).toThrow("private_key");
		});
	});

	describe("loadHarvestConfig", () => {
		it("loads required harvest config", () => {
			process.env.HARVEST_ACCESS_TOKEN = "tok-test";
			process.env.HARVEST_ACCOUNT_ID = "123456";
			process.env.HARVEST_PROJECT_ID = "789";
			process.env.HARVEST_VACATION_TASK_ID = "111";
			process.env.HARVEST_SICK_TASK_ID = "222";

			const config = loadHarvestConfig();
			expect(config.accessToken).toBe("tok-test");
			expect(config.accountId).toBe("123456");
			expect(config.projectId).toBe(789);
			expect(config.vacationTaskId).toBe(111);
			expect(config.sickTaskId).toBe(222);
		});

		it("throws on missing access token", () => {
			expect(() => loadHarvestConfig()).toThrow("HARVEST_ACCESS_TOKEN");
		});

		it("throws on non-integer project ID", () => {
			process.env.HARVEST_ACCESS_TOKEN = "tok-test";
			process.env.HARVEST_ACCOUNT_ID = "123456";
			process.env.HARVEST_PROJECT_ID = "not-a-number";
			process.env.HARVEST_VACATION_TASK_ID = "111";
			process.env.HARVEST_SICK_TASK_ID = "222";

			expect(() => loadHarvestConfig()).toThrow("must be an integer");
		});
	});
});
