/**
 * AI service interface.
 * Wraps any LLM provider behind a simple contract so we can mock it in tests.
 */

import type { Static, TSchema } from "@sinclair/typebox";

export interface AIMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

export interface AICompletionRequest {
	messages: AIMessage[];
	systemPrompt?: string;
	maxTokens?: number;
	temperature?: number;
}

export interface AICompletionResponse {
	content: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
	stopReason: "stop" | "length" | "error";
}

export interface AIStructuredRequest {
	messages: AIMessage[];
	/** Additional system prompt context. Merged with the JSON schema instruction. */
	systemPrompt?: string;
	maxTokens?: number;
	temperature?: number;
	/** Number of retry attempts if the LLM returns invalid JSON. Default: 1 */
	maxRetries?: number;
}

export interface AIService {
	/**
	 * Send a completion request and get a full response.
	 */
	complete(request: AICompletionRequest): Promise<AICompletionResponse>;

	/**
	 * Send a completion request and get back a validated, typed object.
	 * Uses a TypeBox schema to instruct the LLM to return JSON and validates the response.
	 * Retries once on parse/validation failure by feeding the error back to the LLM.
	 */
	completeStructured<T extends TSchema>(request: AIStructuredRequest, schema: T): Promise<Static<T>>;
}
