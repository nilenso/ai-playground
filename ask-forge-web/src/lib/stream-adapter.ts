/**
 * Types and event mapping for the new ask() API (nilenso/megasthenes#99).
 *
 * Defines the StreamEvent, TurnResult (step-based), and AskStream types
 * matching the library's actual implementation, and provides mapping functions
 * that translate new stream events into the shapes the client currently expects.
 */

// =============================================================================
// Stream Events (tagged union) — matches library's types.ts exactly
// =============================================================================

interface TurnStart {
	type: "turn_start";
	turnId: string;
	prompt: string;
	timestamp: number;
}

interface TurnEnd {
	type: "turn_end";
	turnId: string;
	metadata: TurnMetadata;
}

interface ThinkingDelta {
	type: "thinking_delta";
	delta: string;
}

interface Thinking {
	type: "thinking";
	text: string;
}

interface ThinkingSummaryDelta {
	type: "thinking_summary_delta";
	delta: string;
}

interface ThinkingSummary {
	type: "thinking_summary";
	text: string;
}

interface TextDelta {
	type: "text_delta";
	delta: string;
}

interface Text {
	type: "text";
	text: string;
}

interface ToolUseStart {
	type: "tool_use_start";
	toolCallId: string;
	name: string;
}

interface ToolUseDelta {
	type: "tool_use_delta";
	toolCallId: string;
	name: string;
	delta: string;
}

interface ToolUseEnd {
	type: "tool_use_end";
	toolCallId: string;
	name: string;
	params: Record<string, unknown>;
}

interface ToolResult {
	type: "tool_result";
	toolCallId: string;
	name: string;
	output: string;
	isError: boolean;
	durationMs: number;
}

interface Compaction {
	type: "compaction";
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	firstKeptOrdinal: number;
	readFiles: string[];
	modifiedFiles: string[];
}

interface TurnError {
	type: "error";
	message: string;
	details?: unknown;
}

export type StreamEvent =
	| TurnStart
	| TurnEnd
	| ThinkingDelta
	| Thinking
	| ThinkingSummaryDelta
	| ThinkingSummary
	| TextDelta
	| Text
	| ToolUseStart
	| ToolUseDelta
	| ToolUseEnd
	| ToolResult
	| Compaction
	| TurnError;

// =============================================================================
// Steps & TurnResult — step-based design from PR #99
// =============================================================================

export type Step =
	| { type: "thinking"; text: string }
	| { type: "thinking_summary"; text: string }
	| { type: "text"; text: string; role: "assistant" }
	| {
			type: "tool_call";
			id: string;
			name: string;
			params: Record<string, unknown>;
			output: string;
			isError: boolean;
			durationMs: number;
	  }
	| { type: "iteration_start"; index: number }
	| { type: "compaction"; summary: string; tokensBefore: number; tokensAfter: number }
	| { type: "error"; source: "provider" | "library"; message: string; details?: unknown; recoverable: boolean };

export interface TokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}

export interface ModelConfig {
	provider: string;
	id: string;
}

export interface ThinkingConfig {
	type?: string;
	effort?: string;
}

export interface TurnMetadata {
	iterations: number;
	latencyMs: number;
	model: ModelConfig;
	thinkingEffort?: string;
	repo: { url: string; commitish: string };
	config: { maxIterations: number; thinkingConfig?: ThinkingConfig };
}

export interface TurnResult {
	readonly id: string;
	readonly prompt: string;
	readonly steps: readonly Step[];
	readonly usage: TokenUsage;
	readonly metadata: TurnMetadata;
	readonly error: { message: string; details?: unknown } | null;
	readonly startedAt: number;
	readonly endedAt: number;
}

// =============================================================================
// AskStream
// =============================================================================

export interface AskStream extends AsyncIterable<StreamEvent> {
	result(): Promise<TurnResult>;
}

// =============================================================================
// AskOptions
// =============================================================================

export interface AskOptions {
	afterTurn?: string;
	model?: ModelConfig;
	maxIterations?: number;
	thinking?: ThinkingConfig;
	signal?: AbortSignal;
}

// =============================================================================
// Session and SessionConfig
// =============================================================================

export interface RepoConfig {
	url: string;
	token?: string;
	commitish?: string;
	forge?: "github" | "gitlab";
}

export interface SessionConfig {
	repo: RepoConfig;
	model: ModelConfig;
	systemPrompt?: string;
	maxIterations: number;
	thinking?: ThinkingConfig;
	compaction?: Partial<CompactionSettings>;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	contextWindow: number;
}

export interface PublicSessionConfig {
	readonly repo: RepoConfig;
	readonly model: ModelConfig;
	readonly systemPrompt: string;
	readonly maxIterations: number;
	readonly thinking?: ThinkingConfig;
	readonly compaction?: Partial<CompactionSettings>;
}

export interface Repo {
	url: string;
	localPath: string;
	commitish: string;
}

export interface Session {
	readonly id: string;
	readonly repo: Repo;
	readonly config: PublicSessionConfig;
	ask(prompt: string, options?: AskOptions): AskStream;
	getTurns(): readonly TurnResult[];
	getTurn(id: string): TurnResult | null;
	close(): void;
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
export function getTurnToolCalls(
	turn: TurnResult,
): { id: string; name: string; params: Record<string, unknown>; output: string; isError: boolean; durationMs: number }[] {
	return turn.steps.filter((s): s is Extract<Step, { type: "tool_call" }> => s.type === "tool_call");
}

// =============================================================================
// Event Mapping: new StreamEvent → client-expected shapes
// =============================================================================

/**
 * Maps a new-API StreamEvent to the shape the client currently expects.
 * Returns null for events that should be skipped.
 */
export function mapStreamEvent(event: StreamEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "turn_start":
			return { type: "thinking" };

		case "thinking_delta":
			return { type: "thinking_delta", delta: event.delta };

		case "thinking":
			return null;

		case "thinking_summary_delta":
			return null;

		case "thinking_summary":
			return null;

		case "text_delta":
			return { type: "text_delta", delta: event.delta };

		case "text":
			return null;

		case "tool_use_start":
			return { type: "tool_start", name: event.name };

		case "tool_use_delta":
			return null;

		case "tool_use_end":
			return { type: "tool_end", name: event.name, arguments: event.params };

		case "tool_result":
			return null;

		case "compaction":
			return {
				type: "compaction",
				tokensBefore: event.tokensBefore,
				tokensAfter: event.tokensAfter,
			};

		case "error":
			return null;

		case "turn_end":
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
