import { Hono } from "hono";
import type { Database } from "@db/sqlite";

import {
	createAuditLog,
	deleteSessionsForUser,
	findUserById,
	listUsers,
	revokeCredentialsForUser,
	updateUserPasskeyResetRequired,
} from "../db/repos.ts";
import { requireApiAdmin } from "../auth/sessions.ts";

export function createAdminRouter({ db }: { db: Database }): Hono {
	const app = new Hono();

	app.get("/admin/users", (c) => {
		requireApiAdmin(c);
		return c.json({ users: listUsers(db) });
	});

	app.post("/admin/users/:id/reset-passkey", (c) => {
		const auth = requireApiAdmin(c);
		const targetUserId = c.req.param("id");
		const targetUser = findUserById(db, targetUserId);
		if (!targetUser) {
			return c.json({ error: "User not found." }, 404);
		}

		revokeCredentialsForUser(db, targetUserId);
		updateUserPasskeyResetRequired(db, targetUserId, true);
		deleteSessionsForUser(db, targetUserId);
		createAuditLog(db, {
			id: crypto.randomUUID(),
			adminUserId: auth.user.id,
			targetUserId,
			action: "reset-passkey",
			metadataJson: JSON.stringify({ username: targetUser.username }),
		});

		if (c.req.header("accept")?.includes("text/html")) {
			return c.redirect("/admin");
		}
		return c.json({ ok: true });
	});

	return app;
}
