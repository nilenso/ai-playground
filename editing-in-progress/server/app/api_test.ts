import { createLocalHandler } from "./api.ts";
import { LocalApplication } from "./local_app.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("local API requires its random bearer token", async () => {
  const app = new LocalApplication(
    "123e4567-e89b-42d3-a456-426614174000",
    "Alice",
  );
  const handler = createLocalHandler({
    app,
    token: "local-secret",
    uiDirectory: "ui/dist",
  });
  const denied = await handler(new Request("http://127.0.0.1/api/bootstrap"));
  assertEquals(denied.status, 401);
  const accepted = await handler(
    new Request("http://127.0.0.1/api/bootstrap", {
      headers: { authorization: "Bearer local-secret" },
    }),
  );
  assertEquals(accepted.status, 200);
  const state = await accepted.json();
  assertEquals(state.name, "Alice");
  if (typeof state.snapshotBase64 !== "string" || !state.snapshotBase64) {
    throw new Error("bootstrap omitted the Automerge snapshot");
  }
});

Deno.test("static index requires token while health remains public", async () => {
  const app = new LocalApplication(
    "123e4567-e89b-42d3-a456-426614174000",
    "Alice",
  );
  const handler = createLocalHandler({
    app,
    token: "local-secret",
    uiDirectory: "ui/dist",
  });
  assertEquals(
    (await handler(new Request("http://127.0.0.1/health"))).status,
    200,
  );
  assertEquals((await handler(new Request("http://127.0.0.1/"))).status, 401);
  const index = await handler(
    new Request("http://127.0.0.1/?token=local-secret"),
  );
  assertEquals(index.status, 200);
  assertEquals(index.headers.get("x-content-type-options"), "nosniff");
  if (
    !index.headers.get("content-security-policy")?.includes(
      "script-src 'self' 'wasm-unsafe-eval'",
    )
  ) {
    throw new Error(
      "content security policy blocks the Automerge WebAssembly module",
    );
  }
});
