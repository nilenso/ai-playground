import { Hono } from "hono";
import {
	clearAuthCookie,
	createAuthMiddleware,
	createAuthProvider,
	createUser,
	findAuthProvider,
	type GitHubUser,
	generateJwt,
	getUserById,
	getUserFromContext,
	setAuthCookie,
	updateAuthProvider,
	updateUser,
} from "../lib/auth.ts";
import { AUTH_CONFIG, AuthProvider } from "../lib/auth-config.ts";

const auth = new Hono();

// Generate random state for CSRF protection
function generateState(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// In-memory state store
const pendingStates = new Map<string, { createdAt: number }>();
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
	pendingStates.set(state, { createdAt: Date.now() });

	const params = new URLSearchParams({
		client_id: AUTH_CONFIG.github.clientId,
		redirect_uri: `${AUTH_CONFIG.app.url}/api/auth/github/callback`,
		scope: AUTH_CONFIG.github.scopes.join(" "),
		state,
	});

	return c.redirect(`${AUTH_CONFIG.github.authorizeUrl}?${params.toString()}`);
});

/**
 * GET /api/auth/github/callback
 * Handles OAuth callback from GitHub
 */
auth.get("/github/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	// Handle error from GitHub
	if (error) {
		console.error("[Auth] GitHub OAuth error:", error);
		return c.redirect("/?error=oauth_denied");
	}

	// Validate required params
	if (!code || !state) {
		return c.redirect("/?error=invalid_callback");
	}

	// Validate state to prevent CSRF
	if (!pendingStates.has(state)) {
		return c.redirect("/?error=invalid_state");
	}
	pendingStates.delete(state);

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
				redirect_uri: `${AUTH_CONFIG.app.url}/api/auth/github/callback`,
			}),
		});

		const tokenData = await tokenResponse.json();

		if (tokenData.error) {
			console.error("[Auth] Token exchange error:", tokenData.error);
			return c.redirect("/?error=token_exchange_failed");
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
			console.error("[Auth] Failed to fetch user info");
			return c.redirect("/?error=user_fetch_failed");
		}

		const githubUser: GitHubUser = await userResponse.json();
		console.log("[Auth] GitHub user:", githubUser.login, githubUser.id);

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
			// New user - create user and auth provider
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
		}

		if (!user) {
			return c.redirect("/?error=user_not_found");
		}

		// Generate JWT and set cookie
		const jwt = await generateJwt(user);
		console.log("[Auth] Setting cookie for user:", user.username);
		setAuthCookie(c, jwt);

		console.log("[Auth] Redirecting to /");
		// Redirect to app
		return c.redirect("/");
	} catch (err) {
		console.error("[Auth] OAuth callback error:", err);
		return c.redirect("/?error=auth_failed");
	}
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
	console.log("[Auth] Status check - token present:", !!token);

	if (!token) {
		return c.json({ authenticated: false });
	}

	try {
		const payload = await verify(token, AUTH_CONFIG.jwt.secret, "HS256");
		console.log("[Auth] JWT verified, payload:", payload);
		const now = Math.floor(Date.now() / 1000);

		if (typeof payload.exp === "number" && payload.exp < now) {
			console.log("[Auth] Token expired");
			return c.json({ authenticated: false });
		}

		// Fetch full user data for avatar
		const user = getUserById(payload.sub as number);
		console.log("[Auth] User found:", user?.username);

		return c.json({
			authenticated: true,
			username: payload.username,
			avatarUrl: user?.avatar_url || null,
		});
	} catch (err) {
		console.log("[Auth] JWT verification failed:", err);
		return c.json({ authenticated: false });
	}
});

export default auth;
