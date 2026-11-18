import assert from "node:assert/strict";

// Copy into a disposable final-image container only; this seeds that container's throwaway database.
if (process.env.CONTAINER_SMOKE_TEST !== "1")
	throw new Error("Requires CONTAINER_SMOKE_TEST=1 in a disposable container");
const { approveUser, createUser, generateJwt } = await import("../src/lib/auth.ts");
const { createSession, findOrCreateRepository } = await import("../src/lib/db.ts");
const base = "http://127.0.0.1:3000";
const request = (path: string, token?: string) =>
	fetch(`${base}${path}`, { redirect: "manual", headers: token ? { cookie: `auth_token=${token}` } : {} });

for (let attempt = 0; attempt < 50; attempt++) {
	try {
		if ((await request("/api/health")).ok) break;
	} catch {
		// The main server may still be importing dependencies after migrations finish.
	}
	await Bun.sleep(100);
}
assert.equal((await request("/api/health")).status, 200);
assert.equal((await request("/")).status, 200);
assert.equal((await request("/index.js")).status, 200);
assert.equal((await fetch("http://127.0.0.1:3001/")).status, 200);
assert.equal((await request("/api/sessions")).status, 401);
assert.equal((await request("/api/auth/me")).status, 401);
const oauth = await request("/api/auth/github");
assert.equal(oauth.status, 302);
const location = new URL(oauth.headers.get("location") ?? "");
assert.equal(location.origin, "https://github.com");
assert.equal(location.searchParams.get("state")?.length, 64);
const invalidCallback = await request("/api/auth/github/callback?code=dummy&state=invalid");
assert.equal(invalidCallback.headers.get("location"), "/?error=invalid_state");

const user = createUser({ username: "container-smoke", displayName: null, email: null, avatarUrl: null });
const token = await generateJwt(user);
assert.equal((await request("/api/sessions", token)).status, 403);
approveUser(user.id);
const emptySessions = await request("/api/sessions", token);
assert.equal(emptySessions.status, 200);
assert.deepEqual(await emptySessions.json(), []);
const repository = findOrCreateRepository({
	userInputUrl: "https://github.com/dummy/dummy",
	gitUrl: "https://github.com/dummy/dummy.git",
	defaultCommit: "dummy-commit",
});
createSession({ id: "container-smoke-session", userId: user.id, repositoryId: repository.id, title: "Dummy session" });
const sessions = await (await request("/api/sessions", token)).json();
assert.equal(sessions[0].id, "container-smoke-session");
assert.equal((await request("/api/sessions/container-smoke-session/messages", token)).status, 200);
assert.equal((await fetch("http://127.0.0.1:3001/api/sessions")).status, 200);
const logout = await fetch(`${base}/api/auth/logout`, { method: "POST" });
assert.equal(logout.status, 200);
assert.match(logout.headers.get("set-cookie") ?? "", /auth_token=;/);

await new Promise<void>((resolve, reject) => {
	const ws = new WebSocket("ws://127.0.0.1:3000/ws");
	const timeout = setTimeout(() => {
		ws.close();
		reject(new Error("WebSocket ping timed out"));
	}, 2000);
	ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
	ws.onerror = () => reject(new Error("WebSocket error"));
	ws.onmessage = (message) => {
		clearTimeout(timeout);
		ws.close();
		try {
			assert.equal(JSON.parse(String(message.data)).type, "pong");
			resolve();
		} catch (error) {
			reject(error);
		}
	};
});
console.log("PASS: final-image migrations, dual UI, OAuth state, JWT/waitlist/session routes and WebSocket ping");
