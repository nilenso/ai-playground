import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { Database } from "@db/sqlite";

import type { AppConfig } from "../config.ts";
import { isSecureCookie } from "../config.ts";
import { sha256Base64Url } from "../lib/crypto.ts";
import {
	createSession,
	deleteExpiredSessions,
	deleteSession,
	findUserById,
	getSession,
	touchSession,
} from "../db/repos.ts";
import type { User } from "../types.ts";

export type AuthState = {
	user: User;
	sessionId: string;
};

export async function createAuthenticatedSession(
	c: Context,
	db: Database,
	config: AppConfig,
	userId: string,
): Promise<void> {
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
	const userAgent = c.req.header("user-agent") ?? null;
	const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
	const ipHash = forwardedFor ? await sha256Base64Url(forwardedFor) : null;

	createSession(db, {
		id: sessionId,
		userId,
		expiresAt,
		userAgent,
		ipHash,
	});

	setCookie(c, config.sessionCookieName, sessionId, {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: isSecureCookie(config),
		expires: new Date(expiresAt),
	});
}

export function clearAuthenticatedSession(c: Context, db: Database, config: AppConfig): void {
	const sessionId = getCookie(c, config.sessionCookieName);
	if (sessionId) {
		deleteSession(db, sessionId);
	}
	deleteCookie(c, config.sessionCookieName, { path: "/" });
}

export function sessionMiddleware(db: Database, config: AppConfig): MiddlewareHandler {
	return async (c, next) => {
		deleteExpiredSessions(db);
		const sessionId = getCookie(c, config.sessionCookieName);
		if (sessionId) {
			const session = getSession(db, sessionId);
			if (session && new Date(session.expires_at).getTime() > Date.now()) {
				const user = findUserById(db, session.user_id);
				if (user) {
					touchSession(db, session.id);
					c.set("auth", { user, sessionId: session.id } satisfies AuthState);
				} else {
					deleteSession(db, sessionId);
				}
			} else if (sessionId) {
				deleteSession(db, sessionId);
			}
		}
		await next();
	};
}

export function requireAuth(c: Context): AuthState {
	const auth = c.get("auth") as AuthState | undefined;
	if (!auth) {
		throw new HTTPException(302, { res: c.redirect("/login") });
	}
	return auth;
}

export function requireApiAuth(c: Context): AuthState {
	const auth = c.get("auth") as AuthState | undefined;
	if (!auth) {
		throw new HTTPException(401, { res: c.json({ error: "Authentication required." }, 401) });
	}
	return auth;
}

export function requireAdmin(c: Context): AuthState {
	const auth = requireAuth(c);
	if (auth.user.role !== "admin") {
		throw new HTTPException(403, { res: c.text("Forbidden", 403) });
	}
	return auth;
}

export function requireApiAdmin(c: Context): AuthState {
	const auth = requireApiAuth(c);
	if (auth.user.role !== "admin") {
		throw new HTTPException(403, { res: c.json({ error: "Admin access required." }, 403) });
	}
	return auth;
}
