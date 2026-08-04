import * as v from "valibot";

import { DEFAULT_KNOWN_LANGUAGE, DEFAULT_TARGET_LANGUAGE, isSupportedLanguage } from "./constants/languages.ts";

export const usernameSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(3, "Username must be at least 3 characters."),
	v.maxLength(32, "Username must be at most 32 characters."),
	v.regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, underscores, or dashes only."),
);

export const searchRequestSchema = v.pipe(
	v.object({
		term: v.pipe(
			v.string(),
			v.trim(),
			v.minLength(1, "Enter a word or short phrase."),
			v.maxLength(80, "Search must be 80 characters or fewer."),
		),
		knownLanguage: v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported known language.")),
		targetLanguage: v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported target language.")),
	}),
	v.check(({ knownLanguage, targetLanguage }) => knownLanguage !== targetLanguage, "Choose two different languages."),
);

export const saveVocabRequestSchema = v.object({
	sourceTerm: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
	normalizedSourceTerm: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
	knownLanguage: v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported known language.")),
	targetLanguage: v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported target language.")),
	partOfSpeech: v.optional(v.nullable(v.string())),
	translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
	register: v.optional(v.nullable(v.string())),
	whenToUse: v.optional(v.nullable(v.string())),
	explanation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
	exampleTarget: v.optional(v.nullable(v.string())),
	exampleKnown: v.optional(v.nullable(v.string())),
	notes: v.optional(v.array(v.string())),
	modelName: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const registerRequestSchema = v.object({
	username: usernameSchema,
	displayName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
});

export const loginRequestSchema = v.object({
	username: usernameSchema,
});

export function defaultSearchState(): { knownLanguage: string; targetLanguage: string } {
	return {
		knownLanguage: DEFAULT_KNOWN_LANGUAGE,
		targetLanguage: DEFAULT_TARGET_LANGUAGE,
	};
}

export function formatValibotError(
	error: v.ValiError<v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>,
): string {
	const firstIssue = error.issues[0] as { message?: string } | undefined;
	return firstIssue?.message ?? "Invalid request.";
}
