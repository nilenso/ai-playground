import { randomUUID } from "node:crypto";
import type { Step, TurnResult } from "@nilenso/megasthenes";
import type { DbMessage, DbTurn } from "./db.ts";

/**
 * Parse a row from the `turns` table into a `TurnResult`. The JSON columns
 * are written by `wrapSession` from a real `TurnResult`, so this is the
 * inverse of that serialization.
 */
export function parseTurnRow(row: DbTurn): TurnResult {
	return {
		id: row.turn_id,
		prompt: row.prompt,
		steps: JSON.parse(row.steps_json) as Step[],
		usage: JSON.parse(row.usage_json),
		metadata: JSON.parse(row.metadata_json),
		error: row.error_json ? JSON.parse(row.error_json) : null,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

/**
 * Best-effort reconstruction of `TurnResult[]` from rows of the legacy
 * `messages` table. Used only for sessions created before the `turns`
 * table existed (Phase 4 migration).
 *
 * Each user message starts a new turn. Subsequent assistant rows have
 * their content blocks unpacked into `text` / `thinking` / `tool_call`
 * steps, and tool rows fill in the corresponding `tool_call.output`
 * by matching `tool_arguments` (which holds the upstream `toolCallId`).
 *
 * Token usage and per-turn metadata cannot be recovered from the legacy
 * schema; stub values are written so the library accepts the shape.
 */
export function dbMessagesToTurns(messages: DbMessage[], repoUrl: string, commitish: string): TurnResult[] {
	const turns: TurnResult[] = [];
	let pending: { id: string; prompt: string; steps: Step[]; startedAt: number; endedAt: number } | null = null;

	const flush = () => {
		if (!pending) return;
		turns.push({
			id: pending.id,
			prompt: pending.prompt,
			steps: pending.steps,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			metadata: {
				iterations: 1,
				latencyMs: pending.endedAt - pending.startedAt,
				model: { provider: "restored", id: "restored" },
				repo: { url: repoUrl, commitish },
				config: { maxIterations: 0 },
			},
			error: null,
			startedAt: pending.startedAt,
			endedAt: pending.endedAt,
		});
		pending = null;
	};

	for (const m of messages) {
		const ts = new Date(m.created_at).getTime();
		if (m.role === "user") {
			flush();
			pending = {
				id: randomUUID(),
				prompt: m.content ?? "",
				steps: [{ type: "iteration_start", index: 0 }],
				startedAt: ts,
				endedAt: ts,
			};
			continue;
		}

		if (!pending) continue;

		if (m.role === "assistant") {
			let parsed: Array<Record<string, unknown>> = [];
			try {
				parsed = JSON.parse(m.content ?? "[]");
			} catch {
				// Pre-JSON-format rows: treat content as plain assistant text
				pending.steps.push({ type: "text", text: m.content ?? "", role: "assistant" });
				pending.endedAt = ts;
				continue;
			}
			for (const b of parsed) {
				if (b.type === "text" && typeof b.text === "string") {
					pending.steps.push({ type: "text", text: b.text, role: "assistant" });
				} else if (b.type === "thinking" && typeof b.thinking === "string") {
					pending.steps.push({ type: "thinking", text: b.thinking });
				} else if (b.type === "toolCall" && typeof b.name === "string") {
					pending.steps.push({
						type: "tool_call",
						id: typeof b.toolCallId === "string" ? b.toolCallId : randomUUID(),
						name: b.name,
						params: (b.arguments as Record<string, unknown>) ?? {},
						output: "",
						isError: false,
						durationMs: 0,
					});
				}
			}
			pending.endedAt = ts;
		} else if (m.role === "tool") {
			const callId = m.tool_arguments;
			const idx = pending.steps.findIndex((s) => s.type === "tool_call" && s.id === callId && s.output === "");
			if (idx >= 0) {
				const call = pending.steps[idx] as Extract<Step, { type: "tool_call" }>;
				pending.steps[idx] = { ...call, output: m.tool_result ?? m.content ?? "" };
			}
			pending.endedAt = ts;
		}
	}
	flush();
	return turns;
}
