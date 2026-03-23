/**
 * Build client bundle with cache-busting hash.
 *
 * 1. Runs `bun build` to produce public/index.js
 * 2. Computes a content hash of the bundle
 * 3. Updates the <script> tag in public/index.html with ?v=<hash>
 *
 * The hash is deterministic — same source produces the same hash,
 * so rebuilding without code changes won't dirty git.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Build the client bundle
execSync("bun build src/client/index.tsx --outdir public --minify", {
	stdio: "inherit",
});

// Compute content hash of the built bundle
const bundle = readFileSync("public/index.js");
const hash = createHash("sha256").update(bundle).digest("hex").slice(0, 8);

// Inject cache-busting query param into index.html
const htmlPath = "public/index.html";
const html = readFileSync(htmlPath, "utf-8");
const scriptTagPattern = /src="\/index\.js(?:\?v=[a-f0-9]+)?"/;

if (!scriptTagPattern.test(html)) {
	console.error("Warning: could not find script tag to update in index.html");
} else {
	const updated = html.replace(scriptTagPattern, `src="/index.js?v=${hash}"`);
	writeFileSync(htmlPath, updated);
	console.log(`Cache-bust: index.js?v=${hash}`);
}
