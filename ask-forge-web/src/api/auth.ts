import { Hono } from "hono";
import {
	approveUser,
	clearAuthCookie,
	createAdminMiddleware,
	createAuthMiddleware,
	createAuthProvider,
	createUser,
	findAuthProvider,
	type GitHubUser,
	generateJwt,
	getUserById,
	getUserFromContext,
	getWaitlistCount,
	getWaitlistedUsers,
	setAuthCookie,
	updateAuthProvider,
	updateUser,
} from "../lib/auth.ts";
import { AUTH_CONFIG, AuthProvider } from "../lib/auth-config.ts";
import { sendApprovalEmail } from "../lib/email.ts";
import { authLogger } from "../lib/logger.ts";

const auth = new Hono();

// Generate random state for CSRF protection
function generateState(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// In-memory state store
const pendingStates = new Map<string, { createdAt: number; returnTo?: string }>();
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

// Cleanup old states periodically
setInterval(() => {
	const now = Date.now();
	for (const [state, data] of pendingStates) {
		if (now - data.createdAt > STATE_TTL) {
			pendingStates.delete(state);
		}
	}
}, 60 * 1000); // Every minute

/**
 * GET /api/auth/github
 * Initiates GitHub OAuth flow by redirecting to GitHub
 */
auth.get("/github", (c) => {
	const state = generateState();
	const returnTo = c.req.query("returnTo");
	pendingStates.set(state, { createdAt: Date.now(), returnTo: returnTo || undefined });

	const params = new URLSearchParams({
		client_id: AUTH_CONFIG.github.clientId,
		redirect_uri: `${AUTH_CONFIG.app.url}/api/auth/github/callback`,
		scope: AUTH_CONFIG.github.scopes.join(" "),
		state,
	});

	return c.redirect(`${AUTH_CONFIG.github.authorizeUrl}?${params.toString()}`);
});

/**
 * Helper to process GitHub OAuth callback
 * Returns user and JWT on success, or error redirect URL on failure
 */
async function processGitHubCallback(
	code: string,
	callbackUrl: string,
): Promise<
	| { success: true; user: NonNullable<ReturnType<typeof getUserById>>; jwt: string }
	| { success: false; redirectUrl: string }
> {
	try {
		// Exchange code for access token
		const tokenResponse = await fetch(AUTH_CONFIG.github.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: AUTH_CONFIG.github.clientId,
				client_secret: AUTH_CONFIG.github.clientSecret,
				code,
				redirect_uri: callbackUrl,
			}),
		});

		const tokenData = await tokenResponse.json();

		if (tokenData.error) {
			authLogger.error("GitHub token exchange failed: {error}", { error: tokenData.error });
			return { success: false, redirectUrl: "/?error=token_exchange_failed" };
		}

		const accessToken = tokenData.access_token;

		// Fetch user info from GitHub
		const userResponse = await fetch(AUTH_CONFIG.github.userUrl, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
			},
		});

		if (!userResponse.ok) {
			authLogger.error("Failed to fetch GitHub user info: HTTP {status}", { status: userResponse.status });
			return { success: false, redirectUrl: "/?error=user_fetch_failed" };
		}

		const githubUser: GitHubUser = await userResponse.json();

		// Check if this GitHub account is already linked
		const authProvider = findAuthProvider(AuthProvider.GitHub, String(githubUser.id));
		let user: Awaited<ReturnType<typeof getUserById>> = null;

		if (authProvider) {
			// Existing user - update tokens and user info
			updateAuthProvider(authProvider.id, { accessToken });
			user = getUserById(authProvider.user_id);

			if (user) {
				updateUser(user.id, {
					username: githubUser.login,
					displayName: githubUser.name,
					email: githubUser.email,
					avatarUrl: githubUser.avatar_url,
				});
				user = getUserById(user.id);
			}
		} else {
			// New user — create account (anyone can sign up)
			user = createUser({
				username: githubUser.login,
				displayName: githubUser.name,
				email: githubUser.email,
				avatarUrl: githubUser.avatar_url,
			});

			createAuthProvider({
				userId: user.id,
				provider: AuthProvider.GitHub,
				providerUserId: String(githubUser.id),
				accessToken,
				refreshToken: null,
			});

			authLogger.info("New user {username} added to waitlist", { username: githubUser.login });
		}

		if (!user) {
			return { success: false, redirectUrl: "/?error=user_not_found" };
		}

		// Generate JWT
		const jwt = await generateJwt(user);
		authLogger.info("User authenticated: {username} (id={userId}, provider=github, isNew={isNewUser})", {
			username: user.username,
			userId: user.id,
			isNewUser: !authProvider,
		});
		return { success: true, user, jwt };
	} catch (err) {
		authLogger.error("OAuth callback error: {error}", {
			error: err instanceof Error ? err.message : String(err),
		});
		return { success: false, redirectUrl: "/?error=auth_failed" };
	}
}

/**
 * GET /api/auth/github/callback
 * Handles OAuth callback from GitHub (production)
 */
auth.get("/github/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	// Handle error from GitHub
	if (error) {
		return c.redirect("/?error=oauth_denied");
	}

	// Validate required params
	if (!code || !state) {
		return c.redirect("/?error=invalid_callback");
	}

	// Validate state to prevent CSRF
	const stateData = pendingStates.get(state);
	if (!stateData) {
		return c.redirect("/?error=invalid_state");
	}
	const returnTo = stateData.returnTo;
	pendingStates.delete(state);

	const callbackUrl = `${AUTH_CONFIG.app.url}/api/auth/github/callback`;
	const result = await processGitHubCallback(code, callbackUrl);

	if (!result.success) {
		return c.redirect(result.redirectUrl);
	}

	setAuthCookie(c, result.jwt);
	// Redirect to returnTo if provided and it's a relative path (prevent open redirect)
	if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
		return c.redirect(returnTo);
	}
	return c.redirect("/");
});

/**
 * POST /api/auth/logout
 * Clears auth cookie and logs user out
 */
auth.post("/logout", (c) => {
	clearAuthCookie(c);
	return c.json({ success: true });
});

/**
 * GET /api/auth/me
 * Returns current user info (protected route)
 */
auth.get("/me", createAuthMiddleware(), (c) => {
	const payload = getUserFromContext(c);

	if (!payload) {
		return c.json({ error: "Not authenticated" }, 401);
	}

	const user = getUserById(payload.sub);

	if (!user) {
		clearAuthCookie(c);
		return c.json({ error: "User not found" }, 404);
	}

	// Return user info without sensitive data
	return c.json({
		id: user.id,
		username: user.username,
		displayName: user.display_name,
		email: user.email,
		avatarUrl: user.avatar_url,
		status: user.status,
		isAdmin: user.is_admin,
	});
});

/**
 * GET /api/auth/status
 * Check if user is authenticated (doesn't require auth)
 */
auth.get("/status", async (c) => {
	const { getCookie } = await import("hono/cookie");
	const { verify } = await import("hono/jwt");

	const token = getCookie(c, "auth_token");

	if (!token) {
		return c.json({ authenticated: false });
	}

	try {
		const payload = await verify(token, AUTH_CONFIG.jwt.secret, "HS256");
		const now = Math.floor(Date.now() / 1000);

		if (typeof payload.exp === "number" && payload.exp < now) {
			return c.json({ authenticated: false });
		}

		const user = getUserById(payload.sub as number);

		return c.json({
			authenticated: true,
			username: payload.username,
			avatarUrl: user?.avatar_url || null,
			status: user?.status ?? "waitlisted",
			isAdmin: user?.is_admin ?? false,
			waitlistCount: user?.is_admin ? getWaitlistCount() : 0,
		});
	} catch {
		return c.json({ authenticated: false });
	}
});

// ─── Admin endpoints ─────────────────────────────────────────────────────────

/**
 * GET /api/auth/admin/waitlist
 * Lists all waitlisted users (admin only)
 */
auth.get("/admin/waitlist", createAdminMiddleware(), (c) => {
	return c.json(getWaitlistedUsers());
});

/**
 * POST /api/auth/admin/approve/:userId
 * Approve a waitlisted user (admin only)
 */
auth.post("/admin/approve/:userId", createAdminMiddleware(), (c) => {
	const payload = getUserFromContext(c);
	const userId = Number(c.req.param("userId"));
	if (Number.isNaN(userId)) {
		return c.json({ error: "Invalid user ID" }, 400);
	}

	const user = getUserById(userId);
	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	if (user.status !== "waitlisted") {
		return c.json({ error: "User is not on the waitlist" }, 400);
	}

	approveUser(userId);
	authLogger.info("Admin {admin} approved user {username} (id={userId})", {
		admin: payload.username,
		username: user.username,
		userId,
	});

	// Send approval email (fire-and-forget — don't block the response)
	if (user.email) {
		sendApprovalEmail({
			to: user.email,
			username: user.username,
			appUrl: AUTH_CONFIG.app.url,
		}).catch(() => {}); // logged inside sendApprovalEmail
	} else {
		authLogger.warn("No email on file for {username} — skipping approval email", { username: user.username });
	}

	return c.json({ success: true });
});

export default auth;
