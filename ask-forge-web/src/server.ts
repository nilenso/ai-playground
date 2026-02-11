import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { serveStatic } from "hono/bun";
import auth from "./api/auth.ts";
import api from "./api/index.ts";
import { AUTH_CONFIG, validateAuthConfig } from "./lib/auth-config.ts";
import { extractRepoFromUrl } from "./lib/extract-repo-from-url.ts";
import { websocketHandler } from "./websocket.ts";

// Validate auth config on startup
validateAuthConfig();

// Disable all SSH keys for git operations - only HTTPS or explicitly provided keys should work
// TODO: Add support for explicitly passing SSH keys per-request
// When that's implemented, we'll need to:
// 1. Accept SSH key content in the /api/connect request
// 2. Write it to a temp file
// 3. Set GIT_SSH_COMMAND per-operation with -i pointing to that temp file
// 4. Clean up the temp file after the operation
process.env.GIT_SSH_COMMAND = "ssh -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o StrictHostKeyChecking=accept-new";

const app = new Hono();

// Auth routes (before API for /api/auth/* to take priority)
app.route("/api/auth", auth);

// API routes
app.route("/api", api);

// Bookmarklet endpoint - extracts repo URL from Referer header and redirects
// Usage: Create a bookmark with URL: https://your-askforge.com/go
// When clicked from a GitHub/GitLab/etc page, it redirects with the repo pre-filled
// Requires user to be logged in
app.get("/go", async (c) => {
	// Check authentication via cookie
	const token = getCookie(c, "auth_token");
	if (!token) {
		return c.redirect("/?error=not-logged-in");
	}

	try {
		const payload = await verify(token, AUTH_CONFIG.jwt.secret, "HS256");
		const now = Math.floor(Date.now() / 1000);
		if (typeof payload.exp === "number" && payload.exp < now) {
			return c.redirect("/?error=not-logged-in");
		}
	} catch {
		return c.redirect("/?error=not-logged-in");
	}

	const referer = c.req.header("Referer");

	if (!referer) {
		// No referer - redirect to home with an error hint
		return c.redirect("/?error=no-referer");
	}

	const { repoUrl, error } = extractRepoFromUrl(referer);

	if (!repoUrl) {
		// Not a recognized forge URL - redirect to home
		console.log(`[/go] Failed to extract repo from referer: ${referer} - ${error}`);
		return c.redirect("/?error=not-a-repo");
	}

	// Redirect with repo URL and auto-connect flag
	const redirectUrl = `/?repo=${encodeURIComponent(repoUrl)}&auto=1`;
	return c.redirect(redirectUrl);
});

// SPA routes - serve index.html for client-side routing
// These must come before the static file middleware
// /c/:sessionId - session permalink
app.get("/c/:sessionId", serveStatic({ path: "./public/index.html" }));
// /share/:token - shared session view
app.get("/share/:token", serveStatic({ path: "./public/index.html" }));

// Serve static files from public directory
app.use("/*", serveStatic({ root: "./public" }));

// Fallback to index.html for SPA routing
app.get("*", serveStatic({ path: "./public/index.html" }));

const port = process.env.PORT || 3000;

console.log(`🚀 Server running at http://localhost:${port}`);

export default {
	port,
	fetch(req: Request, server: import("bun").Server<{ sessionId: string | null }>) {
		// Handle WebSocket upgrade requests
		const url = new URL(req.url);
		if (url.pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
			const upgraded = server.upgrade(req, {
				data: { sessionId: null },
			});
			if (upgraded) {
				return undefined;
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Handle all other requests with Hono
		return app.fetch(req, server);
	},
	websocket: websocketHandler,
	idleTimeout: 120, // 2 minutes for long-running LLM requests
};
