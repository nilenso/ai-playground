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
	LLM_MODEL_NAME: "llm.model_name",
	LLM_TOKEN_COUNT_PROMPT: "llm.token_count.prompt",
	LLM_TOKEN_COUNT_COMPLETION: "llm.token_count.completion",
	LLM_TOKEN_COUNT_TOTAL: "llm.token_count.total",
	INPUT_VALUE: "input.value",
	OUTPUT_VALUE: "output.value",
	INPUT_MIME_TYPE: "input.mime_type",
	OUTPUT_MIME_TYPE: "output.mime_type",
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

	onStart(span: Span, parentContext: Context): void {
		this.inner.onStart(span, parentContext);
	}

	onEnd(span: ReadableSpan): void {
		const attrs = span.attributes as Record<string, unknown>;

		// Drop no-op compaction spans — they add noise when no compaction occurred
		if (span.name === "compaction" && attrs["ask_forge.compaction.was_compacted"] === false) {
			return;
		}

		// Map model name
		const model = attrs["gen_ai.request.model"];
		if (typeof model === "string") {
			// Strip "openrouter/" prefix so Phoenix can match its pricing table
			attrs[OI_ATTR.LLM_MODEL_NAME] = model.replace(/^openrouter\//, "");
		}

		// Map token counts
		const inputTokens = attrs["gen_ai.usage.input_tokens"];
		const outputTokens = attrs["gen_ai.usage.output_tokens"];
		if (typeof inputTokens === "number") attrs[OI_ATTR.LLM_TOKEN_COUNT_PROMPT] = inputTokens;
		if (typeof outputTokens === "number") attrs[OI_ATTR.LLM_TOKEN_COUNT_COMPLETION] = outputTokens;
		if (typeof inputTokens === "number" && typeof outputTokens === "number") {
			attrs[OI_ATTR.LLM_TOKEN_COUNT_TOTAL] = inputTokens + outputTokens;
		}

		const traceId = span.spanContext().traceId;

		if (span.name === "gen_ai.chat") {
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
			const input = findEventContent(span, GENAI_EVENT.TOOL_CALL_ARGUMENTS);
			const output = findEventContent(span, GENAI_EVENT.TOOL_CALL_RESULT);
			const toolName = attrs["gen_ai.tool.name"];
			if (input) {
				// Include tool name so the Info tab shows which tool was called
				const inputObj = toolName ? { tool: toolName, arguments: JSON.parse(input) } : JSON.parse(input);
				attrs[OI_ATTR.INPUT_VALUE] = JSON.stringify(inputObj);
				attrs[OI_ATTR.INPUT_MIME_TYPE] = "application/json";
			}
			if (output) {
				attrs[OI_ATTR.OUTPUT_VALUE] = output;
				attrs[OI_ATTR.OUTPUT_MIME_TYPE] = "text/plain";
			}
		} else if (span.name === "ask") {
			// Set the question as input
			const input = findEventContent(span, GENAI_EVENT.INPUT_MESSAGES);
			if (input) {
				attrs[OI_ATTR.INPUT_VALUE] = input;
				attrs[OI_ATTR.INPUT_MIME_TYPE] = "text/plain";
			}

			// Inject the buffered final answer as output
			const finalOutput = this.traceOutputs.get(traceId);
			if (finalOutput) {
				const outputText = extractTextFromContentBlocks(finalOutput);
				attrs[OI_ATTR.OUTPUT_VALUE] = outputText;
				attrs[OI_ATTR.OUTPUT_MIME_TYPE] = "text/plain";

				// Also add a gen_ai.output.messages event so Phoenix shows it in the events panel
				const events = span.events as { name: string; time: [number, number]; attributes?: Record<string, unknown> }[];
				events.push({
					name: GENAI_EVENT.OUTPUT_MESSAGES,
					time: span.endTime as [number, number],
					attributes: { content: finalOutput },
				});

				this.traceOutputs.delete(traceId);
			}
		}

		this.inner.onEnd(span);
	}

	async forceFlush(): Promise<void> {
		return this.inner.forceFlush();
	}

	async shutdown(): Promise<void> {
		this.traceOutputs.clear();
		return this.inner.shutdown();
	}
}

// ─── Backend-specific processor builders ────────────────────────────────────

async function buildPhoenixProcessor(): Promise<SpanProcessor | null> {
	const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;
	if (!endpoint) return null;

	const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
	const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
	const exporter = new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }));
	return new PhoenixEnrichingProcessor(exporter);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const phoenixProcessor = await buildPhoenixProcessor();

if (phoenixProcessor) {
	const { NodeSDK } = await import("@opentelemetry/sdk-node");
	const sdk = new NodeSDK({ spanProcessors: [phoenixProcessor] });
	sdk.start();
	console.log("[tracing] OpenTelemetry SDK started — exporting to Phoenix");
} else {
	console.log("[tracing] No tracing backends configured — tracing disabled");
}
