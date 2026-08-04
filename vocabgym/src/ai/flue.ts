import { configureProvider, createAgent } from "@flue/runtime";
import {
	Bash,
	bashFactoryToSessionEnv,
	createFlueContext,
	InMemoryFs,
	InMemorySessionStore,
	resolveModel,
} from "@flue/runtime/internal";

import type { AppConfig } from "../config.ts";
import { buildTranslationPrompt } from "./prompts.ts";
import { type TranslationResult, translationResultSchema } from "./schema.ts";

const MODEL_NAME = "openrouter/mistralai/mistral-small-2603";
const SEARCH_TIMEOUT_MS = 20_000;

export function getTranslationModelName(): string {
	return MODEL_NAME;
}

export async function runTranslationSearch(
	config: AppConfig,
	input: { term: string; knownLanguage: string; targetLanguage: string },
): Promise<TranslationResult> {
	if (!config.openRouterApiKey) {
		throw new Error("OPENROUTER_API_KEY is not configured.");
	}

	configureProvider("openrouter", {
		apiKey: config.openRouterApiKey,
		baseUrl: config.openRouterBaseUrl,
		headers: {
			"HTTP-Referer": config.publicBaseUrl,
			"X-Title": "VocabGym",
		},
	});

	const agent = createAgent(() => ({
		model: MODEL_NAME,
		instructions:
			"You are a precise translation assistant. Follow the caller's schema exactly and never return markdown.",
	}));

	const ctx = createFlueContext({
		id: crypto.randomUUID(),
		payload: input,
		env: Deno.env.toObject(),
		defaultStore: new InMemorySessionStore(),
		createDefaultEnv: () => bashFactoryToSessionEnv(() => new Bash({ fs: new InMemoryFs(), cwd: "/workspace" })),
		agentConfig: {
			systemPrompt: "",
			skills: {},
			model: undefined,
			resolveModel,
		},
	});

	const harness = await ctx.init(agent);
	const session = await harness.session();
	const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

	try {
		const response = await session.prompt(buildTranslationPrompt(input), {
			result: translationResultSchema,
			signal,
		});
		return response.data;
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error("AI search timed out after 20 seconds. Please try again.");
		}
		throw error;
	}
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}
