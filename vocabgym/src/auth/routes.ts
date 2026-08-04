import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "@db/sqlite";
import * as v from "valibot";

import type { AppConfig } from "../config.ts";
import { formatValibotError, loginRequestSchema, registerRequestSchema } from "../validation.ts";
import { ChallengeStore } from "./challenges.ts";
import { finishLogin, finishRegistration, startLogin, startRegistration } from "./passkeys.ts";
import { clearAuthenticatedSession, createAuthenticatedSession } from "./sessions.ts";

type AuthDependencies = {
	db: Database;
	config: AppConfig;
	challengeStore: ChallengeStore;
};

export function createAuthRouter({ db, config, challengeStore }: AuthDependencies): Hono {
	const app = new Hono();

	app.post("/register/options", async (c) => {
		try {
			const body = await c.req.json();
			const input = v.parse(registerRequestSchema, body);
			const options = await startRegistration(db, config, challengeStore, input);
			return c.json(options);
		} catch (error) {
			return handleAuthError(c, error);
		}
	});

	app.post("/register/verify", async (c) => {
		try {
			const body = await c.req.json();
			const input = v.parse(registerRequestSchema, body);
			const user = await finishRegistration(db, config, challengeStore, {
				username: input.username,
				displayName: input.displayName,
				response: body.response as Record<string, unknown>,
			});
			await createAuthenticatedSession(c, db, config, user.id);
			return c.json({ ok: true });
		} catch (error) {
			return handleAuthError(c, error);
		}
	});

	app.post("/login/options", async (c) => {
		try {
			const body = await c.req.json();
			const input = v.parse(loginRequestSchema, body);
			const options = await startLogin(db, config, challengeStore, input.username);
			return c.json(options);
		} catch (error) {
			return handleAuthError(c, error);
		}
	});

	app.post("/login/verify", async (c) => {
		try {
			const body = await c.req.json();
			const input = v.parse(loginRequestSchema, body);
			const user = await finishLogin(db, config, challengeStore, {
				username: input.username,
				response: body.response as Record<string, unknown>,
			});
			await createAuthenticatedSession(c, db, config, user.id);
			return c.json({ ok: true });
		} catch (error) {
			return handleAuthError(c, error);
		}
	});

	app.post("/logout", (c) => {
		clearAuthenticatedSession(c, db, config);
		return c.redirect("/login");
	});

	return app;
}

function handleAuthError(c: Context, error: unknown) {
	if (error instanceof v.ValiError) {
		return c.json({ error: formatValibotError(error) }, 400);
	}
	if (error instanceof Error) {
		return c.json({ error: error.message }, 400);
	}
	return c.json({ error: "Authentication failed." }, 500);
}
