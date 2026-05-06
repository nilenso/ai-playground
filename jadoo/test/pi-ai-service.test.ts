import { describe, expect, it } from "bun:test";
import { PiAIService } from "../src/services/ai/pi-ai-service.js";

describe("PiAIService", () => {
	it("constructs successfully for a known provider/model", () => {
		expect(
			() =>
				new PiAIService({
					provider: "openrouter",
					model: "google/gemma-4-31b-it:free",
					apiKey: "test-key",
				}),
		).not.toThrow();
	});

	it("fails fast for an unknown model", () => {
		expect(
			() =>
				new PiAIService({
					provider: "openrouter",
					model: "definitely/not-a-real-model",
					apiKey: "test-key",
				}),
		).toThrow(/Unknown AI model/);
	});
});
