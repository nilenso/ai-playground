import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import api from "./api/index.ts";
import { websocketHandler } from "./websocket.ts";

// Disable all SSH keys for git operations - only HTTPS or explicitly provided keys should work
// TODO: Add support for explicitly passing SSH keys per-request
// When that's implemented, we'll need to:
// 1. Accept SSH key content in the /api/connect request
// 2. Write it to a temp file
// 3. Set GIT_SSH_COMMAND per-operation with -i pointing to that temp file
// 4. Clean up the temp file after the operation
process.env.GIT_SSH_COMMAND = "ssh -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o StrictHostKeyChecking=accept-new";

const app = new Hono();

// API routes
app.route("/api", api);

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
