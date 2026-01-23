import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import api from "./api/index.ts";

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
	fetch: app.fetch,
};
