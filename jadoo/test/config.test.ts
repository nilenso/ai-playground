import { describe, expect, it } from "bun:test";
import {
	loadAIConfig,
	loadGoogleCalendarConfig,
	loadHarvestConfig,
	loadSlackConfig,
	parseServiceAccountJson,
} from "../src/config/index.js";

describe("Config loading", () => {
	describe("loadSlackConfig", () => {
		it("loads required slack config", () => {
			const raw = { slack: { botToken: "xoxb-test", signingSecret: "secret", appToken: "xapp-test" }};

			const config = loadSlackConfig(raw);

			expect(config.botToken).toBe("xoxb-test");
			expect(config.signingSecret).toBe("secret");
			expect(config.appToken).toBe("xapp-test");
			expect(config.port).toBeUndefined();
		});

		it("throws on missing required field", () => {
			expect(() => loadSlackConfig({ slack: {} })).toThrow("botToken");
		});

		it("parses optional port", () => {
			const raw = { slack: { botToken: "xoxb-test", signingSecret: "secret", appToken: "xapp-test", port: 3000 }};
			const config = loadSlackConfig(raw);
			expect(config.port).toBe(3000);
		});
	});

	describe("loadAIConfig", () => {
		it("loads required AI config", () => {
			const raw = { ai: { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-test" }};

			const config = loadAIConfig(raw);
			expect(config.provider).toBe("anthropic");
			expect(config.model).toBe("claude-sonnet-4-20250514");
			expect(config.apiKey).toBe("sk-test");
		});

		it("throws on missing API key", () => {
			const raw = { ai: { provider: "anthropic", model: "claude-sonnet-4-20250514" }};
			expect(() => loadAIConfig(raw)).toThrow("apiKey");
		});
	});

	describe("loadGoogleCalendarConfig", () => {
		it("loads from individual fields", () => {
			const raw = { gcal: { calendarId: "cal@group.calendar.google.com", clientEmail: "bot@test.iam.gserviceaccount.com", privateKey: "key" }};

			const config = loadGoogleCalendarConfig(raw);
			expect(config.calendarId).toBe("cal@group.calendar.google.com");
			expect(config.clientEmail).toBe("bot@test.iam.gserviceaccount.com");
			expect(config.privateKey).toBe("key");
		});

		it("loads from base64 service account JSON", () => {
			const json = { client_email: "bot@json", private_key: "key@json" };
			const base64 = btoa(JSON.stringify(json));
			const raw = { gcal: { calendarId: "cal@group", serviceAccountJsonBase64: base64 }};

			const config = loadGoogleCalendarConfig(raw);
			expect(config.clientEmail).toBe("bot@json");
			expect(config.privateKey).toBe("key@json");
			expect(config.calendarId).toBe("cal@group");
		});

		it("base64 JSON takes precedence over individual fields", () => {
			const json = { client_email: "bot@json", private_key: "key@json" };
			const base64 = btoa(JSON.stringify(json));
			const raw = { gcal: { calendarId: "cal@group", serviceAccountJsonBase64: base64, clientEmail: "bot@env", privateKey: "key@env" }};

			const config = loadGoogleCalendarConfig(raw);
			expect(config.clientEmail).toBe("bot@json");
			expect(config.privateKey).toBe("key@json");
		});

		it("throws when calendarId is missing", () => {
			const raw = { gcal: { clientEmail: "bot@test.iam.gserviceaccount.com", privateKey: "key" }};
			expect(() => loadGoogleCalendarConfig(raw)).toThrow("calendarId");
		});

		it("throws when neither auth format is provided", () => {
			const raw = { gcal: { calendarId: "cal@group.calendar.google.com" }};
			expect(() => loadGoogleCalendarConfig(raw)).toThrow("clientEmail");
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
			const raw = { harvest: { accessToken: "tok-test", accountId: "123456" }};

			const config = loadHarvestConfig(raw);
			expect(config.accessToken).toBe("tok-test");
			expect(config.accountId).toBe("123456");
		});

		it("throws on missing access token", () => {
			expect(() => loadHarvestConfig({ harvest: {} })).toThrow("accessToken");
		});
	});
});
