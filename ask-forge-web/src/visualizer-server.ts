import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const app = new Hono();

const sessionDir = process.env.SESSION_DIR || ".";

// API to list available session files
app.get("/api/sessions", async (c) => {
	try {
		const files = await readdir(sessionDir);
		const jsonlFiles = files
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.reverse(); // Most recent first (assuming naming convention)
		return c.json({ success: true, files: jsonlFiles });
	} catch (err) {
		return c.json({
			success: false,
			error: err instanceof Error ? err.message : "Failed to list sessions",
		}, 500);
	}
});

// API to load a specific session file
app.get("/api/session/:filename", async (c) => {
	const filename = c.req.param("filename");
	
	// Security: ensure filename doesn't escape the directory
	if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
		return c.json({ success: false, error: "Invalid filename" }, 400);
	}
	
	if (!filename.endsWith(".jsonl")) {
		return c.json({ success: false, error: "Invalid file type" }, 400);
	}
	
	const filePath = join(sessionDir, filename);
	
	try {
		const file = Bun.file(filePath);
		const text = await file.text();
		const lines = text.trim().split("\n");
		const events = lines.map((line) => JSON.parse(line));
		return c.json({ success: true, events });
	} catch (err) {
		return c.json({ 
			success: false, 
			error: err instanceof Error ? err.message : "Failed to load session" 
		}, 500);
	}
});

// Serve visualizer.html for root
app.get("/", async (c) => {
	const html = await Bun.file("./public/visualizer.html").text();
	return c.html(html);
});

// Serve static files from public directory
app.use("/*", serveStatic({ root: "./public" }));

const port = process.env.PORT || 3001;

console.log(`📊 Visualizer running at http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch,
};
