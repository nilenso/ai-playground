/**
 * Event mapping layer over the library's AskStream API.
 *
 * Re-exports the canonical types from @nilenso/megasthenes and provides
 * mapping functions that translate library StreamEvents into the shapes
 * the existing client (WebSocket / SSE consumers) still expects.
 */

import type {
	AskOptions,
	AskStream,
	PublicSessionConfig,
	Step,
	StreamEvent,
	TokenUsage,
	TurnMetadata,
	TurnResult,
} from "@nilenso/megasthenes";

export type { AskOptions, AskStream, PublicSessionConfig, Step, StreamEvent, TokenUsage, TurnMetadata, TurnResult };

// Structural view of the Session surface we use (library's Session is a class
// with private fields, so we can't re-export it for duck-typed wrappers).
export interface Session {
	readonly id: string;
	readonly repo: { url: string; localPath: string; commitish: string };
	readonly config: PublicSessionConfig;
	ask(prompt: string, options?: AskOptions): AskStream;
	getTurns(): readonly TurnResult[];
	getTurn(id: string): TurnResult | null;
	close(): Promise<void>;
}

// =============================================================================
// Helpers to extract data from step-based TurnResult
// =============================================================================

/** Extract the final assembled response text from a TurnResult's steps. */
export function getTurnText(turn: TurnResult): string {
	return turn.steps
		.filter((s): s is Extract<Step, { type: "text" }> => s.type === "text")
		.map((s) => s.text)
		.join("\n");
}

/** Extract all thinking text from a TurnResult's steps. */
export function getTurnThinking(turn: TurnResult): string | null {
	const parts = turn.steps
		.filter((s): s is Extract<Step, { type: "thinking" }> => s.type === "thinking")
		.map((s) => s.text);
	return parts.length > 0 ? parts.join("\n") : null;
}

/** Extract all tool calls from a TurnResult's steps. */
export function getTurnToolCalls(turn: TurnResult): {
	id: string;
	name: string;
	params: Record<string, unknown>;
	output: string;
	isError: boolean;
	durationMs: number;
}[] {
	return turn.steps.filter((s): s is Extract<Step, { type: "tool_call" }> => s.type === "tool_call");
}

// =============================================================================
// Event Mapping: library StreamEvent → client-expected shapes
// =============================================================================

/**
 * Maps a library StreamEvent to the shape the client currently expects.
 * Returns null for events that should be skipped.
 */
export function mapStreamEvent(event: StreamEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "turn_start":
			return { type: "thinking" };

		case "thinking_delta":
			return { type: "thinking_delta", delta: event.delta };

		case "text_delta":
			return { type: "text_delta", delta: event.delta };

		case "tool_use_start":
			return { type: "tool_start", name: event.name };

		case "tool_use_end":
			return { type: "tool_end", name: event.name, arguments: event.params };

		case "compaction":
			return {
				type: "compaction",
				tokensBefore: event.tokensBefore,
				tokensAfter: event.tokensAfter,
			};

		default:
			return null;
	}
}

/**
 * Build the "done" event data from a TurnResult for the client.
 * Extracts text and tool calls from the step-based TurnResult.
 */
export function buildDoneData(turn: TurnResult): {
	success: boolean;
	response: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
	error?: string;
} {
	return {
		success: !turn.error,
		response: getTurnText(turn),
		toolCalls: getTurnToolCalls(turn).map((tc) => ({ name: tc.name, arguments: tc.params })),
		error: turn.error?.message,
	};
}
