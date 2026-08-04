import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Database } from "@db/sqlite";

import type { AppConfig } from "./config.ts";
import { ChallengeStore } from "./auth/challenges.ts";
import { createAdminRouter } from "./admin/routes.ts";
import { createAuthRouter } from "./auth/routes.ts";
import { requireAdmin, requireAuth, sessionMiddleware } from "./auth/sessions.ts";
import { listUsers, listVocabEntries } from "./db/repos.ts";
import { createRateLimit } from "./lib/rate-limit.ts";
import { createVocabRouter, serializeVocabEntries } from "./vocab/routes.ts";
import { renderAdminPage, renderAppPage, renderLoginPage } from "./web/render.ts";

export function createApp({ db, config }: { db: Database; config: AppConfig }): Hono {
	const app = new Hono();
	const challengeStore = new ChallengeStore();
	const authLimiter = createRateLimit({
		limit: 20,
		windowMs: 10 * 60_000,
		message: "Too many authentication attempts. Please wait a bit.",
	});

	app.use("*", sessionMiddleware(db, config));
	app.use("/auth/*", authLimiter);

	app.get("/assets/:name", async (c) => {
		const name = c.req.param("name");
		if (name !== "login.js" && name !== "app.js") {
			throw new HTTPException(404);
		}
		const source = await Deno.readTextFile(new URL(`../static/${name}`, import.meta.url));
		c.header("content-type", "application/javascript; charset=utf-8");
		return c.body(source);
	});

	app.get("/login", (c) => {
		if ((c.get("auth" as never) as unknown) !== undefined) {
			return c.redirect("/");
		}
		return c.html(renderLoginPage());
	});

	app.get("/", (c) => {
		const auth = requireAuth(c);
		return c.html(
			renderAppPage({
				user: auth.user,
				vocabEntries: serializeVocabEntries(listVocabEntries(db, auth.user.id)),
			}),
		);
	});

	app.get("/admin", (c) => {
		const auth = requireAdmin(c);
		return c.html(renderAdminPage({ currentUser: auth.user, users: listUsers(db) }));
	});

	app.route("/auth", createAuthRouter({ db, config, challengeStore }));
	app.route("/api", createVocabRouter({ db, config }));
	app.route("/api", createAdminRouter({ db }));

	app.onError((error, c) => {
		if (error instanceof HTTPException) {
			return error.getResponse();
		}
		console.error(error);
		return c.text("Internal server error", 500);
	});

	return app;
}
