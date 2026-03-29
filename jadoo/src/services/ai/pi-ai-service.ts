/**
 * AI service implementation using pi-ai.
 */

import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	getModel,
	type KnownProvider,
	type Model,
	type Static,
	type TextContent,
	type TSchema,
} from "@mariozechner/pi-ai";
import type { AIConfig } from "../../config/index.js";
import type { AICompletionRequest, AICompletionResponse, AIService, AIStructuredRequest } from "../../interfaces/ai.js";
import { buildStructuredSystemPrompt, validateStructuredResponse } from "./structured.js";

function mapStopReason(reason: AssistantMessage["stopReason"]): AICompletionResponse["stopReason"] {
	switch (reason) {
		case "stop":
		case "toolUse":
			return "stop";
		case "length":
			return "length";
		default:
			return "error";
	}
}

export class PiAIService implements AIService {
	// pi-ai Model generic requires exact literal types that can't be known at runtime
	private model: Model<Api>;
	private config: AIConfig;

	constructor(config: AIConfig) {
		this.config = config;
		// The generics require literal string types — we cast because config is dynamic.
		this.model = getModel(config.provider as KnownProvider, config.model as never);
	}

	async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
		const context: Context = {
			systemPrompt: request.systemPrompt,
			messages: request.messages
				.filter((m) => m.role !== "system")
				.map((m) => {
					if (m.role === "user") {
						return { role: "user" as const, content: m.content, timestamp: Date.now() };
					}
					// assistant messages from our interface are text-only
					return {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: m.content }],
						api: this.model.api,
						provider: this.model.provider,
						model: this.model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
				}),
		};

		const result = await completeSimple(this.model, context, {
			apiKey: this.config.apiKey,
			maxTokens: request.maxTokens ?? this.config.maxTokens,
			temperature: request.temperature ?? this.config.temperature,
		});

		// Extract text content from the response
		const textParts = result.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text);
		const content = textParts.join("");

		return {
			content,
			usage: {
				inputTokens: result.usage.input,
				outputTokens: result.usage.output,
				totalTokens: result.usage.totalTokens,
			},
			stopReason: mapStopReason(result.stopReason),
		};
	}

	async completeStructured<T extends TSchema>(request: AIStructuredRequest, schema: T): Promise<Static<T>> {
		const maxRetries = request.maxRetries ?? 1;
		const systemPrompt = buildStructuredSystemPrompt(schema, request.systemPrompt);

		// First attempt
		const firstResponse = await this.complete({
			...request,
			systemPrompt,
		});

		const firstResult = validateStructuredResponse(schema, firstResponse.content);
		if (firstResult.ok) {
			return firstResult.value;
		}

		// Retry loop — feed the error back to the LLM
		let lastError = firstResult.error;
		let lastRawContent = firstResponse.content;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const retryResponse = await this.complete({
				...request,
				systemPrompt,
				messages: [
					...request.messages,
					{ role: "assistant", content: lastRawContent },
					{
						role: "user",
						content: `Your previous response was not valid JSON or did not match the required schema.\nError: ${lastError}\nPlease try again. Respond ONLY with valid JSON matching the schema.`,
					},
				],
			});

			const retryResult = validateStructuredResponse(schema, retryResponse.content);
			if (retryResult.ok) {
				return retryResult.value;
			}

			lastError = retryResult.error;
			lastRawContent = retryResponse.content;
		}

		throw new Error(`Structured completion failed after ${maxRetries + 1} attempts. Last error: ${lastError}`);
	}
}
