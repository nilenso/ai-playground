import { Hono } from "hono";
import type { Database } from "@db/sqlite";
import * as v from "valibot";

import type { AppConfig } from "../config.ts";
import { getLanguageLabel } from "../constants/languages.ts";
import { deleteVocabEntry, insertVocabEntry, listVocabEntries } from "../db/repos.ts";
import { formatRelativeTime } from "../lib/time.ts";
import { createRateLimit } from "../lib/rate-limit.ts";
import { requireApiAuth } from "../auth/sessions.ts";
import { runTranslationSearch } from "../ai/flue.ts";
import { formatValibotError, saveVocabRequestSchema, searchRequestSchema } from "../validation.ts";

export function createVocabRouter({ db, config }: { db: Database; config: AppConfig }): Hono {
	const app = new Hono();
	const authRate = createRateLimit({
		limit: 30,
		windowMs: 10 * 60_000,
		message: "Too many searches. Please wait a bit.",
	});

	app.get("/vocab", (c) => {
		const auth = requireApiAuth(c);
		return c.json({ entries: serializeVocabEntries(listVocabEntries(db, auth.user.id)) });
	});

	app.post("/search", authRate, async (c) => {
		const auth = requireApiAuth(c);
		void auth;
		try {
			const body = await c.req.json();
			const input = v.parse(searchRequestSchema, body);
			const result = await runTranslationSearch(config, {
				term: input.term,
				knownLanguage: input.knownLanguage,
				targetLanguage: input.targetLanguage,
			});
			return c.json({ result });
		} catch (error) {
			if (error instanceof v.ValiError) {
				return c.json({ error: formatValibotError(error) }, 400);
			}
			if (error instanceof Error) {
				return c.json({ error: error.message }, 502);
			}
			return c.json({ error: "Search failed." }, 500);
		}
	});

	app.post("/vocab", async (c) => {
		const auth = requireApiAuth(c);
		try {
			const body = await c.req.json();
			const input = v.parse(saveVocabRequestSchema, body);
			const entry = insertVocabEntry(db, {
				id: crypto.randomUUID(),
				user_id: auth.user.id,
				source_term: input.sourceTerm,
				normalized_source_term: input.normalizedSourceTerm,
				known_language: input.knownLanguage,
				target_language: input.targetLanguage,
				part_of_speech: input.partOfSpeech ?? null,
				chosen_translation: input.translation,
				register_label: input.register ?? null,
				when_to_use: input.whenToUse ?? null,
				explanation: input.explanation,
				example_target: input.exampleTarget ?? null,
				example_known: input.exampleKnown ?? null,
				notes_json: input.notes ? JSON.stringify(input.notes) : null,
				model_name: input.modelName,
			});
			return c.json({ entry: serializeVocabEntry(entry) }, 201);
		} catch (error) {
			if (error instanceof v.ValiError) {
				return c.json({ error: formatValibotError(error) }, 400);
			}
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
				return c.json({ error: "That exact vocab entry is already saved." }, 409);
			}
			if (error instanceof Error) {
				return c.json({ error: error.message }, 500);
			}
			return c.json({ error: "Could not save vocab entry." }, 500);
		}
	});

	app.delete("/vocab/:id", (c) => {
		const auth = requireApiAuth(c);
		const deleted = deleteVocabEntry(db, c.req.param("id"), auth.user.id);
		return c.json({ ok: deleted });
	});

	return app;
}

export function serializeVocabEntries(entries: ReturnType<typeof listVocabEntries>) {
	return entries.map(serializeVocabEntry);
}

function serializeVocabEntry(entry: ReturnType<typeof listVocabEntries>[number]) {
	return {
		id: entry.id,
		sourceTerm: entry.source_term,
		translation: entry.chosen_translation,
		knownLanguage: entry.known_language,
		knownLanguageLabel: getLanguageLabel(entry.known_language),
		targetLanguage: entry.target_language,
		targetLanguageLabel: getLanguageLabel(entry.target_language),
		partOfSpeech: entry.part_of_speech,
		register: entry.register_label,
		whenToUse: entry.when_to_use,
		explanation: entry.explanation,
		exampleTarget: entry.example_target,
		exampleKnown: entry.example_known,
		notes: entry.notes_json ? (JSON.parse(entry.notes_json) as string[]) : [],
		modelName: entry.model_name,
		createdAt: entry.created_at,
		createdAtRelative: formatRelativeTime(entry.created_at),
	};
}
