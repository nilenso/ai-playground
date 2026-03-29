/**
 * Integration tests for PiAIService against a real LLM provider.
 *
 * Requires: AI_PROVIDER, AI_MODEL, AI_API_KEY
 *
 * These tests make real API calls and cost real money (small amounts).
 */

import { PiAIService } from "../../src/services/ai/pi-ai-service.js";
import { describeIntegration, expect, it } from "./helpers.js";

const REQUIRED_VARS = ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY"];

describeIntegration("PiAIService (live)", REQUIRED_VARS, (env) => {
	const ai = new PiAIService({
		provider: env.AI_PROVIDER,
		model: env.AI_MODEL,
		apiKey: env.AI_API_KEY,
	});

	it("completes a simple prompt", async () => {
		const result = await ai.complete({
			systemPrompt: "You are a test assistant. Reply with exactly one word.",
			messages: [{ role: "user", content: 'Say the word "hello" and nothing else.' }],
			maxTokens: 16,
		});

		expect(result.content.toLowerCase()).toContain("hello");
		expect(result.stopReason).toBe("stop");
	});

	it("returns usage information", async () => {
		const result = await ai.complete({
			messages: [{ role: "user", content: "Reply with ok" }],
			maxTokens: 16,
		});

		expect(result.usage).toBeDefined();
		expect(result.usage?.inputTokens).toBeGreaterThan(0);
		expect(result.usage?.outputTokens).toBeGreaterThan(0);
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
	});

	it("respects system prompt", async () => {
		const result = await ai.complete({
			systemPrompt: "You only respond in JSON. No markdown fences. Just raw JSON.",
			messages: [{ role: "user", content: 'Return {"status":"ok"}' }],
			maxTokens: 32,
		});

		// Should be parseable JSON
		const parsed = JSON.parse(result.content.trim());
		expect(parsed.status).toBe("ok");
	});
});
