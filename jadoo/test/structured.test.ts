import { describe, expect, it } from "bun:test";
import { type Static, Type } from "@sinclair/typebox";
import { buildStructuredSystemPrompt, extractJson, validateStructuredResponse } from "../src/services/ai/structured.js";
import { MockAIService } from "./mocks.js";

// ─── Schema fixtures ────────────────────────────────────

const ParsedLeaveSchema = Type.Object({
	dates: Type.Array(Type.String({ description: "ISO date string, e.g. 2026-03-30" })),
	leaveType: Type.Union([Type.Literal("full"), Type.Literal("half")]),
	category: Type.Union([Type.Literal("vacation"), Type.Literal("sick")]),
	reason: Type.Optional(Type.String()),
});
type ParsedLeave = Static<typeof ParsedLeaveSchema>;

const SimpleSchema = Type.Object({
	name: Type.String(),
	age: Type.Number(),
});

// ─── extractJson ────────────────────────────────────────

describe("extractJson", () => {
	it("returns raw JSON object as-is", () => {
		const input = '{"name": "Alice", "age": 30}';
		expect(extractJson(input)).toBe(input);
	});

	it("returns raw JSON array as-is", () => {
		const input = "[1, 2, 3]";
		expect(extractJson(input)).toBe(input);
	});

	it("strips markdown json code fence", () => {
		const input = '```json\n{"name": "Bob"}\n```';
		expect(extractJson(input)).toBe('{"name": "Bob"}');
	});

	it("strips markdown code fence without language tag", () => {
		const input = '```\n{"name": "Carol"}\n```';
		expect(extractJson(input)).toBe('{"name": "Carol"}');
	});

	it("extracts JSON from surrounding prose", () => {
		const input = 'Here is the result:\n{"name": "Dave", "age": 25}\nHope that helps!';
		expect(extractJson(input)).toBe('{"name": "Dave", "age": 25}');
	});

	it("handles nested braces correctly", () => {
		const input = '{"outer": {"inner": "value"}, "list": [1, 2]}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles strings with escaped quotes", () => {
		const input = '{"msg": "he said \\"hello\\""}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles strings containing braces", () => {
		const input = '{"template": "use {name} here"}';
		expect(extractJson(input)).toBe(input);
	});

	it("extracts array from surrounding text", () => {
		const input = 'The dates are: ["2026-03-30", "2026-03-31"] as requested.';
		expect(extractJson(input)).toBe('["2026-03-30", "2026-03-31"]');
	});

	it("handles leading whitespace", () => {
		const input = '   \n  {"name": "Eve"}';
		expect(extractJson(input)).toBe('{"name": "Eve"}');
	});

	it("returns original text when no JSON found", () => {
		const input = "no json here at all";
		expect(extractJson(input)).toBe(input);
	});
});

// ─── validateStructuredResponse ─────────────────────────

describe("validateStructuredResponse", () => {
	it("validates correct JSON against schema", () => {
		const result = validateStructuredResponse(SimpleSchema, '{"name": "Alice", "age": 30}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ name: "Alice", age: 30 });
		}
	});

	it("validates a complex leave schema", () => {
		const json = JSON.stringify({
			dates: ["2026-03-30", "2026-03-31"],
			leaveType: "full",
			category: "vacation",
			reason: "family trip",
		});
		const result = validateStructuredResponse(ParsedLeaveSchema, json);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.dates).toEqual(["2026-03-30", "2026-03-31"]);
			expect(result.value.leaveType).toBe("full");
		}
	});

	it("accepts optional fields when missing", () => {
		const json = JSON.stringify({
			dates: ["2026-04-01"],
			leaveType: "half",
			category: "sick",
		});
		const result = validateStructuredResponse(ParsedLeaveSchema, json);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.reason).toBeUndefined();
		}
	});

	it("returns error for invalid JSON", () => {
		const result = validateStructuredResponse(SimpleSchema, "not json at all");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Invalid JSON");
		}
	});

	it("returns error for schema mismatch — wrong type", () => {
		const result = validateStructuredResponse(SimpleSchema, '{"name": "Alice", "age": "thirty"}');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("does not match schema");
		}
	});

	it("returns error for schema mismatch — missing required field", () => {
		const result = validateStructuredResponse(SimpleSchema, '{"name": "Alice"}');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("does not match schema");
		}
	});

	it("returns error for invalid enum value", () => {
		const json = JSON.stringify({
			dates: ["2026-04-01"],
			leaveType: "quarter", // not "full" or "half"
			category: "vacation",
		});
		const result = validateStructuredResponse(ParsedLeaveSchema, json);
		expect(result.ok).toBe(false);
	});

	it("extracts JSON from markdown fences before validating", () => {
		const input = '```json\n{"name": "Bob", "age": 42}\n```';
		const result = validateStructuredResponse(SimpleSchema, input);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ name: "Bob", age: 42 });
		}
	});
});

// ─── buildStructuredSystemPrompt ────────────────────────

describe("buildStructuredSystemPrompt", () => {
	it("includes the JSON schema", () => {
		const prompt = buildStructuredSystemPrompt(SimpleSchema);
		expect(prompt).toContain('"type": "object"');
		expect(prompt).toContain('"name"');
		expect(prompt).toContain("MUST respond with ONLY a valid JSON");
	});

	it("prepends user system prompt when provided", () => {
		const prompt = buildStructuredSystemPrompt(SimpleSchema, "You are a leave parser.");
		expect(prompt).toMatch(/^You are a leave parser\./);
		expect(prompt).toContain("MUST respond with ONLY a valid JSON");
	});

	it("omits user system prompt section when not provided", () => {
		const prompt = buildStructuredSystemPrompt(SimpleSchema);
		expect(prompt).toMatch(/^You MUST respond/);
	});
});

// ─── MockAIService.completeStructured ───────────────────

describe("MockAIService.completeStructured", () => {
	it("returns pre-canned structured responses directly", async () => {
		const ai = new MockAIService();
		const expected: ParsedLeave = {
			dates: ["2026-04-01"],
			leaveType: "full",
			category: "vacation",
			reason: "holiday",
		};
		ai.structuredResponses.push(expected);

		const result = await ai.completeStructured(
			{ messages: [{ role: "user", content: "I need leave" }] },
			ParsedLeaveSchema,
		);

		expect(result).toEqual(expected);
		expect(ai.requests).toHaveLength(1);
	});

	it("falls back to text response queue and validates", async () => {
		const ai = new MockAIService();
		ai.responses.push({
			content: JSON.stringify({ name: "Test", age: 25 }),
			stopReason: "stop",
		});

		const result = await ai.completeStructured({ messages: [{ role: "user", content: "parse this" }] }, SimpleSchema);

		expect(result).toEqual({ name: "Test", age: 25 });
	});

	it("throws when text response doesn't match schema", async () => {
		const ai = new MockAIService();
		ai.defaultResponse = { content: "not json", stopReason: "stop" };

		await expect(
			ai.completeStructured({ messages: [{ role: "user", content: "parse" }] }, SimpleSchema),
		).rejects.toThrow("MockAIService.completeStructured");
	});

	it("records the request for assertions", async () => {
		const ai = new MockAIService();
		ai.structuredResponses.push({ name: "X", age: 1 });

		await ai.completeStructured(
			{ messages: [{ role: "user", content: "test" }], systemPrompt: "be structured" },
			SimpleSchema,
		);

		expect(ai.requests).toHaveLength(1);
		expect(ai.requests[0].systemPrompt).toBe("be structured");
	});

	it("drains structured queue before text queue", async () => {
		const ai = new MockAIService();
		ai.structuredResponses.push({ name: "Structured", age: 1 });
		ai.responses.push({ content: JSON.stringify({ name: "Text", age: 2 }), stopReason: "stop" });

		const r1 = await ai.completeStructured({ messages: [{ role: "user", content: "first" }] }, SimpleSchema);
		const r2 = await ai.completeStructured({ messages: [{ role: "user", content: "second" }] }, SimpleSchema);

		expect(r1).toEqual({ name: "Structured", age: 1 });
		expect(r2).toEqual({ name: "Text", age: 2 });
	});
});
