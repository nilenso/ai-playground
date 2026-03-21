import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { AUTH_CONFIG, type AuthProvider, TOKEN_EXPIRY_DAYS } from "./auth-config.ts";
import { getDb } from "./db.ts";

// JWT Payload structure
export interface JWTPayload {
	sub: number; // user ID
	iat: number; // issued at
	exp: number; // expiration
	username: string;
	[key: string]: unknown;
}

// User interface matching database schema
export interface User {
	id: number;
	username: string;
	display_name: string | null;
	email: string | null;
	avatar_url: string | null;
	created_at: string;
	updated_at: string;
}

// Auth provider interface matching database schema
export interface AuthProviderRecord {
	id: number;
	user_id: number;
	provider: AuthProvider;
	provider_user_id: string;
	access_token: string | null;
	refresh_token: string | null;
	token_expires_at: string;
	created_at: string;
	updated_at: string;
}

// GitHub user response
export interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
	avatar_url: string;
}

const COOKIE_NAME = "auth_token";
const COOKIE_OPTIONS = {
	httpOnly: true,
	secure: process.env.NODE_ENV === "production",
	sameSite: "Lax" as const,
	path: "/",
	maxAge: AUTH_CONFIG.jwt.expiresIn,
};

// Generate JWT for a user
export async function generateJwt(user: User): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: JWTPayload = {
		sub: user.id,
		iat: now,
		exp: now + AUTH_CONFIG.jwt.expiresIn,
		username: user.username,
	};
	return await sign(payload, AUTH_CONFIG.jwt.secret);
}

// Set auth cookie
export function setAuthCookie(c: Context, token: string): void {
	setCookie(c, COOKIE_NAME, token, COOKIE_OPTIONS);
}

// Clear auth cookie
export function clearAuthCookie(c: Context): void {
	deleteCookie(c, COOKIE_NAME, { path: "/" });
}

// Get user from context (after auth middleware)
export function getUserFromContext(c: Context): JWTPayload | null {
	return c.get("jwtPayload") as JWTPayload | null;
}

// Auth middleware - verifies JWT from cookie
export function createAuthMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const token = getCookie(c, COOKIE_NAME);

		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		try {
			const payload = (await verify(token, AUTH_CONFIG.jwt.secret, "HS256")) as JWTPayload;

			// Check expiration
			const now = Math.floor(Date.now() / 1000);
			if (payload.exp < now) {
				clearAuthCookie(c);
				return c.json({ error: "Token expired" }, 401);
			}

			c.set("jwtPayload", payload);
			await next();
		} catch {
			clearAuthCookie(c);
			return c.json({ error: "Invalid token" }, 401);
		}
	};
}

// Optional auth middleware - doesn't block but sets user if available
export function createOptionalAuthMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const token = getCookie(c, COOKIE_NAME);

		if (token) {
			try {
				const payload = (await verify(token, AUTH_CONFIG.jwt.secret, "HS256")) as JWTPayload;
				const now = Math.floor(Date.now() / 1000);
				if (payload.exp >= now) {
					c.set("jwtPayload", payload);
				}
			} catch {
				// Token invalid, continue without auth
			}
		}

		await next();
	};
}

// Database operations for users

export function findUserByUsername(username: string): User | null {
	const db = getDb();
	return db.query<User, [string]>("SELECT * FROM users WHERE username = ?").get(username) || null;
}

export function getUserById(userId: number): User | null {
	const db = getDb();
	return db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId) || null;
}

export function createUser(params: {
	username: string;
	displayName: string | null;
	email: string | null;
	avatarUrl: string | null;
}): User {
	const db = getDb();
	const now = new Date().toISOString();

	const result = db.run(
		`INSERT INTO users (username, display_name, email, avatar_url, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[params.username, params.displayName, params.email, params.avatarUrl, now, now],
	);

	return {
		id: Number(result.lastInsertRowid),
		username: params.username,
		display_name: params.displayName,
		email: params.email,
		avatar_url: params.avatarUrl,
		created_at: now,
		updated_at: now,
	};
}

export function updateUser(
	userId: number,
	params: {
		username?: string;
		displayName?: string | null;
		email?: string | null;
		avatarUrl?: string | null;
	},
): void {
	const db = getDb();
	const updates: string[] = [];
	const values: (string | null)[] = [];

	if (params.username !== undefined) {
		updates.push("username = ?");
		values.push(params.username);
	}
	if (params.displayName !== undefined) {
		updates.push("display_name = ?");
		values.push(params.displayName);
	}
	if (params.email !== undefined) {
		updates.push("email = ?");
		values.push(params.email);
	}
	if (params.avatarUrl !== undefined) {
		updates.push("avatar_url = ?");
		values.push(params.avatarUrl);
	}

	if (updates.length > 0) {
		updates.push("updated_at = ?");
		values.push(new Date().toISOString());
		values.push(String(userId));

		db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, values);
	}
}

// Allowlist check for new signups

export function isUsernameAllowed(githubUsername: string): boolean {
	const db = getDb();
	const row = db
		.query<{ id: number }, [string]>("SELECT id FROM allowed_users WHERE github_username = ?")
		.get(githubUsername);
	return row !== null;
}

// Database operations for auth providers

export function findAuthProvider(provider: AuthProvider, providerUserId: string): AuthProviderRecord | null {
	const db = getDb();
	return (
		db
			.query<AuthProviderRecord, [number, string]>(
				"SELECT * FROM auth_providers WHERE provider = ? AND provider_user_id = ?",
			)
			.get(provider, providerUserId) || null
	);
}

export function createAuthProvider(params: {
	userId: number;
	provider: AuthProvider;
	providerUserId: string;
	accessToken: string | null;
	refreshToken: string | null;
}): AuthProviderRecord {
	const db = getDb();
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const result = db.run(
		`INSERT INTO auth_providers (user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.userId,
			params.provider,
			params.providerUserId,
			params.accessToken,
			params.refreshToken,
			expiresAt,
			now,
			now,
		],
	);

	return {
		id: Number(result.lastInsertRowid),
		user_id: params.userId,
		provider: params.provider,
		provider_user_id: params.providerUserId,
		access_token: params.accessToken,
		refresh_token: params.refreshToken,
		token_expires_at: expiresAt,
		created_at: now,
		updated_at: now,
	};
}

export function updateAuthProvider(
	id: number,
	params: {
		accessToken?: string | null;
		refreshToken?: string | null;
	},
): void {
	const db = getDb();
	const updates: string[] = [];
	const values: (string | null | number)[] = [];

	if (params.accessToken !== undefined) {
		updates.push("access_token = ?");
		values.push(params.accessToken);
	}
	if (params.refreshToken !== undefined) {
		updates.push("refresh_token = ?");
		values.push(params.refreshToken);
	}

	if (updates.length > 0) {
		// Reset token expiry on update
		updates.push("token_expires_at = ?");
		values.push(new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString());

		updates.push("updated_at = ?");
		values.push(new Date().toISOString());
		values.push(id);

		db.run(`UPDATE auth_providers SET ${updates.join(", ")} WHERE id = ?`, values);
	}
}
