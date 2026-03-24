/**
 * OpenTelemetry SDK bootstrap for ask-forge-web.
 *
 * MUST be imported before any other module that uses @opentelemetry/api
 * (i.e., before ask-forge is loaded) so the TracerProvider is
 * registered globally before ask-forge's tracing.ts calls trace.getTracer().
 *
 * Backend: Arize Phoenix (opt-in via PHOENIX_COLLECTOR_ENDPOINT env var).
 * If not configured, tracing is a no-op.
 *
 * Phoenix reads OpenInference llm.* attributes for its built-in token count,
 * cost, and I/O display fields, so this module maps OTel GenAI attributes
 * to OpenInference equivalents.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** GenAI event names emitted by ask-forge's tracing module. */
const GENAI_EVENT = {
	INPUT_MESSAGES: "gen_ai.input.messages",
	OUTPUT_MESSAGES: "gen_ai.output.messages",
	TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
	TOOL_CALL_RESULT: "gen_ai.tool.call.result",
} as const;

/** Extract `content` from the first event matching `eventName`. */
function findEventContent(span: ReadableSpan, eventName: string): string | undefined {
	const event = span.events.find((e) => e.name === eventName);
	if (!event?.attributes) return undefined;
	const content = event.attributes.content;
	return typeof content === "string" ? content : undefined;
}

// ─── OTel GenAI → OpenInference mapping (for Phoenix) ──────────────────────

/** OpenInference attribute keys that Phoenix reads for its built-in UI fields. */
const OI_ATTR = {
	SPAN_KIND: "openinference.span.kind",
	LLM_MODEL_NAME: "llm.model_name",
	LLM_PROVIDER: "llm.provider",
	LLM_TOKEN_COUNT_PROMPT: "llm.token_count.prompt",
	LLM_TOKEN_COUNT_COMPLETION: "llm.token_count.completion",
	LLM_TOKEN_COUNT_TOTAL: "llm.token_count.total",
	LLM_TOKEN_COUNT_CACHE_READ: "llm.token_count.prompt_details.cache_read",
	LLM_TOKEN_COUNT_CACHE_WRITE: "llm.token_count.prompt_details.cache_write",
	INPUT_VALUE: "input.value",
	OUTPUT_VALUE: "output.value",
	INPUT_MIME_TYPE: "input.mime_type",
	OUTPUT_MIME_TYPE: "output.mime_type",
	SESSION_ID: "session.id",
	TOOL_NAME: "tool.name",
	METADATA: "metadata",
} as const;

/**
 * Extracts a plain-text answer from a JSON content blocks array.
 * ask-forge serializes output as `[{"type":"text","text":"..."},...]`.
 */
function extractTextFromContentBlocks(json: string): string {
	try {
		const blocks = JSON.parse(json);
		if (!Array.isArray(blocks)) return json;
		return blocks
			.filter((b: { type: string }) => b.type === "text")
			.map((b: { text: string }) => b.text)
			.join("\n");
	} catch {
		return json;
	}
}

/**
 * Maps OTel GenAI semantic convention attributes to OpenInference attributes
 * so Phoenix's built-in token count, cost, and I/O display fields work.
 *
 * Also propagates the final answer onto the root "ask" span:
 *  - Buffers output from the last gen_ai.chat span (finishReason != "tool_use")
 *  - When the ask span ends, injects the buffered output as output.value
 */
class PhoenixEnrichingProcessor implements SpanProcessor {
	constructor(private readonly inner: SpanProcessor) {}

	/** Buffers the final chat output per trace ID so we can inject it onto the ask span. */
	private traceOutputs = new Map<string, string>();
	/** Accumulates token counts from gen_ai.chat spans per trace ID for the ask span total. */
	private traceTokens = new Map<string, { prompt: number; completion: number }>();
	/** Tracks when each trace ID was first seen, for stale entry eviction. */
	private traceTimestamps = new Map<string, number>();
	private static readonly STALE_THRESHOLD_MS = 30 * 60 * 1000;

	onStart(span: Span, parentContext: Context): void {
		this.inner.onStart(span, parentContext);
	}

	/** Evict buffered entries for traces that never completed (crash, timeout, etc.). */
	private evictStaleEntries(): void {
		const now = Date.now();
		for (const [id, ts] of this.traceTimestamps) {
			if (now - ts > PhoenixEnrichingProcessor.STALE_THRESHOLD_MS) {
				this.traceOutputs.delete(id);
				this.traceTokens.delete(id);
				this.traceTimestamps.delete(id);
			}
		}
	}

	onEnd(span: ReadableSpan): void {
		this.evictStaleEntries();
		const attrs = span.attributes as Record<string, unknown>;

		// Drop no-op compaction spans — they add noise when no compaction occurred
		if (span.name === "compaction" && attrs["ask_forge.compaction.was_compacted"] === false) {
			return;
		}

		// Map model name and provider.
		// gen_ai.request.model is "provider/vendor/model" (e.g. "openrouter/anthropic/claude-sonnet-4.6").
		// gen_ai.provider.name is the pi-ai provider (e.g. "openrouter").
		// Phoenix's pricing table matches bare model names (e.g. "claude-sonnet-4-6"),
		// so we strip both the provider and vendor prefixes.
		const model = attrs["gen_ai.request.model"];
		const provider = attrs["gen_ai.provider.name"];
		if (typeof provider === "string") {
			attrs[OI_ATTR.LLM_PROVIDER] = provider;
		}
		if (typeof model === "string") {
			// Strip all path segments except the last (e.g. "openrouter/anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6")
			const bare = model.split("/").pop() ?? model;
			attrs[OI_ATTR.LLM_MODEL_NAME] = bare;
		}

		// Map token counts — include cache-read tokens in prompt count so the
		// header total matches the actual billed/consumed tokens.
		const inputTokens = attrs["gen_ai.usage.input_tokens"];
		const outputTokens = attrs["gen_ai.usage.output_tokens"];
		const cacheReadTokens = attrs["gen_ai.usage.cache_read.input_tokens"];
		const cacheCreationTokens = attrs["gen_ai.usage.cache_creation.input_tokens"];
		const promptTokens =
			(typeof inputTokens === "number" ? inputTokens : 0) +
			(typeof cacheReadTokens === "number" ? cacheReadTokens : 0) +
			(typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0);
		const completionTokens = typeof outputTokens === "number" ? outputTokens : 0;
		if (promptTokens > 0) attrs[OI_ATTR.LLM_TOKEN_COUNT_PROMPT] = promptTokens;
		if (completionTokens > 0) attrs[OI_ATTR.LLM_TOKEN_COUNT_COMPLETION] = completionTokens;
		if (promptTokens > 0 || completionTokens > 0) {
			attrs[OI_ATTR.LLM_TOKEN_COUNT_TOTAL] = promptTokens + completionTokens;
		}
		if (typeof cacheReadTokens === "number") attrs[OI_ATTR.LLM_TOKEN_COUNT_CACHE_READ] = cacheReadTokens;
		if (typeof cacheCreationTokens === "number") attrs[OI_ATTR.LLM_TOKEN_COUNT_CACHE_WRITE] = cacheCreationTokens;

		const traceId = span.spanContext().traceId;

		if (span.name === "gen_ai.chat") {
			attrs[OI_ATTR.SPAN_KIND] = "LLM";

			// Accumulate token counts for the parent ask span
			if (promptTokens > 0 || completionTokens > 0) {
				const acc = this.traceTokens.get(traceId) ?? { prompt: 0, completion: 0 };
				acc.prompt += promptTokens;
				acc.completion += completionTokens;
				this.traceTokens.set(traceId, acc);
				if (!this.traceTimestamps.has(traceId)) this.traceTimestamps.set(traceId, Date.now());
			}

			const output = findEventContent(span, GENAI_EVENT.OUTPUT_MESSAGES);
			const finishReason = attrs["gen_ai.response.finish_reason"];

			// Set I/O on the individual chat span — use raw JSON so Phoenix
			// renders both text responses and tool-call responses in the Info tab
			const input = findEventContent(span, GENAI_EVENT.INPUT_MESSAGES);
			if (input) {
				attrs[OI_ATTR.INPUT_VALUE] = input;
				attrs[OI_ATTR.INPUT_MIME_TYPE] = "application/json";
			}
			if (output) {
				// Extract plain text from content blocks when possible (e.g. [{"type":"text","text":"..."}]),
				// fall back to raw JSON for tool-call responses
				const text = extractTextFromContentBlocks(output);
				const isPlainText = text !== output && text.length > 0;
				attrs[OI_ATTR.OUTPUT_VALUE] = isPlainText ? text : output;
				attrs[OI_ATTR.OUTPUT_MIME_TYPE] = isPlainText ? "text/plain" : "application/json";
			}

			// Buffer final answer for the parent ask span
			if (output && finishReason && finishReason !== "tool_use") {
				this.traceOutputs.set(traceId, output);
			}
		} else if (span.name === "gen_ai.execute_tool") {
			attrs[OI_ATTR.SPAN_KIND] = "TOOL";
			const input = findEventContent(span, GENAI_EVENT.TOOL_CALL_ARGUMENTS);
			const output = findEventContent(span, GENAI_EVENT.TOOL_CALL_RESULT);
			const toolName = attrs["gen_ai.tool.name"];
			if (typeof toolName === "string") attrs[OI_ATTR.TOOL_NAME] = toolName;
			if (input) {
				// Include tool name so the Info tab shows which tool was called
				try {
					const inputObj = toolName ? { tool: toolName, arguments: JSON.parse(input) } : JSON.parse(input);
					attrs[OI_ATTR.INPUT_VALUE] = JSON.stringify(inputObj);
				} catch {
					attrs[OI_ATTR.INPUT_VALUE] = input;
				}
				attrs[OI_ATTR.INPUT_MIME_TYPE] = "application/json";
			}
			if (output) {
				attrs[OI_ATTR.OUTPUT_VALUE] = output;
				attrs[OI_ATTR.OUTPUT_MIME_TYPE] = "text/plain";
			}
		} else if (span.name === "ask") {
			attrs[OI_ATTR.SPAN_KIND] = "CHAIN";
			// Map session ID
			const sessionId = attrs["ask_forge.session.id"];
			if (typeof sessionId === "string") attrs[OI_ATTR.SESSION_ID] = sessionId;
			// Set metadata with repo context
			const repoUrl = attrs["ask_forge.repo.url"];
			const commitish = attrs["ask_forge.repo.commitish"];
			const iterations = attrs["ask_forge.total_iterations"];
			const toolCalls = attrs["ask_forge.total_tool_calls"];
			const metadata: Record<string, unknown> = {};
			if (typeof repoUrl === "string") metadata.repo_url = repoUrl;
			if (typeof commitish === "string") metadata.commitish = commitish;
			if (typeof iterations === "number") metadata.total_iterations = iterations;
			if (typeof toolCalls === "number") metadata.total_tool_calls = toolCalls;
			if (Object.keys(metadata).length > 0) attrs[OI_ATTR.METADATA] = JSON.stringify(metadata);
			// Set the question as input
			const input = findEventContent(span, GENAI_EVENT.INPUT_MESSAGES);
			if (input) {
				attrs[OI_ATTR.INPUT_VALUE] = input;
				attrs[OI_ATTR.INPUT_MIME_TYPE] = "text/plain";
			}

			// Override token counts with accumulated totals from child gen_ai.chat spans
			// (the ask span's own gen_ai.usage.* only has non-cached counts)
			const accTokens = this.traceTokens.get(traceId);
			if (accTokens) {
				attrs[OI_ATTR.LLM_TOKEN_COUNT_PROMPT] = accTokens.prompt;
				attrs[OI_ATTR.LLM_TOKEN_COUNT_COMPLETION] = accTokens.completion;
				attrs[OI_ATTR.LLM_TOKEN_COUNT_TOTAL] = accTokens.prompt + accTokens.completion;
				this.traceTokens.delete(traceId);
			}

			// Inject the buffered final answer as output
			const finalOutput = this.traceOutputs.get(traceId);
			if (finalOutput) {
				const outputText = extractTextFromContentBlocks(finalOutput);
				attrs[OI_ATTR.OUTPUT_VALUE] = outputText;
				attrs[OI_ATTR.OUTPUT_MIME_TYPE] = "text/plain";

				// Also add a gen_ai.output.messages event so Phoenix shows it in the events panel.
				// ReadableSpan.events is typed readonly but is a mutable array at runtime in the OTel SDK.
				const events = span.events as { name: string; time: [number, number]; attributes?: Record<string, unknown> }[];
				events.push({
					name: GENAI_EVENT.OUTPUT_MESSAGES,
					time: span.endTime as [number, number],
					attributes: { content: finalOutput },
				});

				this.traceOutputs.delete(traceId);
			}
			this.traceTimestamps.delete(traceId);
		}

		this.inner.onEnd(span);
	}

	async forceFlush(): Promise<void> {
		return this.inner.forceFlush();
	}

	async shutdown(): Promise<void> {
		this.traceOutputs.clear();
		this.traceTokens.clear();
		this.traceTimestamps.clear();
		return this.inner.shutdown();
	}
}

// ─── Backend-specific processor builders ────────────────────────────────────

async function buildPhoenixProcessor(): Promise<SpanProcessor | null> {
	const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;
	if (!endpoint) return null;

	const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
	const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
	const headers: Record<string, string> = {};
	const adminSecret = process.env.PHOENIX_ADMIN_SECRET;
	if (adminSecret) {
		headers.authorization = `Bearer ${adminSecret}`;
	}
	const exporter = new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, headers }));
	return new PhoenixEnrichingProcessor(exporter);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const phoenixProcessor = await buildPhoenixProcessor();

if (phoenixProcessor) {
	const { NodeSDK } = await import("@opentelemetry/sdk-node");
	const { resourceFromAttributes } = await import("@opentelemetry/resources");
	const sdk = new NodeSDK({
		resource: resourceFromAttributes({ "openinference.project.name": "ask-forge" }),
		spanProcessors: [phoenixProcessor],
	});
	sdk.start();
	console.log("[tracing] OpenTelemetry SDK started — exporting to Phoenix");
} else {
	console.log("[tracing] No tracing backends configured — tracing disabled");
}
