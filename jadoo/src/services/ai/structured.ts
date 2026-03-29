/**
 * Helpers for structured (JSON schema) AI output.
 *
 * - Builds a system prompt that instructs the LLM to respond with JSON
 * - Extracts JSON from LLM responses (handles markdown fences)
 * - Validates extracted JSON against a TypeBox schema
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

type StructuredResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Build a system prompt that instructs the LLM to return JSON matching the given schema.
 * If the caller provided their own system prompt, it's prepended as context.
 */
export function buildStructuredSystemPrompt(schema: TSchema, userSystemPrompt?: string): string {
	const schemaJson = JSON.stringify(schema, null, 2);

	const parts: string[] = [];

	if (userSystemPrompt) {
		parts.push(userSystemPrompt);
		parts.push("");
	}

	parts.push("You MUST respond with ONLY a valid JSON object matching this JSON schema:");
	parts.push("```json");
	parts.push(schemaJson);
	parts.push("```");
	parts.push("");
	parts.push("Rules:");
	parts.push("- Output ONLY the JSON object, nothing else.");
	parts.push("- Do NOT wrap it in markdown code fences.");
	parts.push("- Do NOT include any explanation, preamble, or commentary.");
	parts.push("- Every field marked as required MUST be present.");

	return parts.join("\n");
}

/**
 * Extract a JSON string from LLM output.
 * Handles common cases: raw JSON, markdown-fenced JSON, and text with embedded JSON.
 */
export function extractJson(raw: string): string {
	const trimmed = raw.trim();

	// Try markdown code fence: ```json ... ``` or ``` ... ```
	const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		return fenceMatch[1].trim();
	}

	// If it starts with { or [, assume raw JSON (possibly with trailing text)
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return trimmed;
	}

	// Last resort: find the first { ... } or [ ... ] block
	const braceStart = trimmed.indexOf("{");
	const bracketStart = trimmed.indexOf("[");

	let start: number;
	let open: string;
	let close: string;

	if (braceStart === -1 && bracketStart === -1) {
		return trimmed; // no JSON found — will fail validation
	}

	if (braceStart === -1) {
		start = bracketStart;
		open = "[";
		close = "]";
	} else if (bracketStart === -1) {
		start = braceStart;
		open = "{";
		close = "}";
	} else if (braceStart < bracketStart) {
		start = braceStart;
		open = "{";
		close = "}";
	} else {
		start = bracketStart;
		open = "[";
		close = "]";
	}

	// Walk forward to find the matching closing bracket
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) depth++;
		if (ch === close) depth--;
		if (depth === 0) {
			return trimmed.slice(start, i + 1);
		}
	}

	return trimmed.slice(start);
}

/**
 * Parse and validate LLM output against a TypeBox schema.
 * Returns a discriminated union so callers can handle errors without exceptions.
 */
export function validateStructuredResponse<T extends TSchema>(
	schema: T,
	rawContent: string,
): StructuredResult<Static<T>> {
	const jsonStr = extractJson(rawContent);

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (e) {
		return {
			ok: false,
			error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}. Raw text: ${jsonStr.slice(0, 200)}`,
		};
	}

	// Use TypeBox Value.Check + Value.Errors for validation
	if (!Value.Check(schema, parsed)) {
		const errors = [...Value.Errors(schema, parsed)];
		const messages = errors.slice(0, 5).map((e) => `  ${e.path}: ${e.message}`);
		return {
			ok: false,
			error: `JSON does not match schema:\n${messages.join("\n")}`,
		};
	}

	return { ok: true, value: parsed as Static<T> };
}
