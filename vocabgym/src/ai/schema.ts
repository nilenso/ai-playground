import * as v from "valibot";

export const translationOptionSchema = v.object({
	rank: v.number(),
	translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
	register: v.optional(v.nullable(v.string())),
	whenToUse: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(280)),
	explanation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
	exampleTarget: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
	exampleKnown: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
	notes: v.optional(v.array(v.string())),
	confidence: v.optional(v.number()),
});

export const translationResultSchema = v.object({
	sourceTerm: v.string(),
	normalizedSourceTerm: v.string(),
	knownLanguage: v.string(),
	targetLanguage: v.string(),
	partOfSpeech: v.optional(v.nullable(v.string())),
	generalNotes: v.optional(v.array(v.string())),
	options: v.pipe(v.array(translationOptionSchema), v.minLength(1), v.maxLength(5)),
});

export type TranslationResult = v.InferOutput<typeof translationResultSchema>;
export type TranslationOption = v.InferOutput<typeof translationOptionSchema>;
