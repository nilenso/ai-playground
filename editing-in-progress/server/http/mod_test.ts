import {
  type CollabSession,
  type CollabSessionHandler,
  createHttpHandler,
  serveHttp,
} from "./mod.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

async function withAssets(
  run: (
    root: string,
    handler: ReturnType<typeof createHttpHandler>,
  ) => Promise<void>,
  options: { maxStaticBytes?: number } = {},
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/index.html`,
      "<!doctype html><title>collab</title>",
    );
    await Deno.writeTextFile(`${root}/app.js`, "console.log('collab');\n");
    await Deno.writeTextFile(`${root}/app.css`, "body { color: black; }\n");
    const sessions: CollabSessionHandler = { onConnect() {} };
    await run(
      root,
      createHttpHandler({ staticRoot: root, sessions, ...options }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("health endpoint is typed, bodyless for HEAD, and rejects other methods", async () => {
  await withAssets(async (_root, handler) => {
    const get = await handler(new Request("http://localhost/health"));
    assertEquals(get.status, 200);
    assertEquals(get.headers.get("content-type"), "text/plain; charset=utf-8");
    assertEquals(get.headers.get("cache-control"), "no-store");
    assertEquals(await get.text(), "ok\n");

    const head = await handler(
      new Request("http://localhost/health", { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");

    const post = await handler(
      new Request("http://localhost/health", { method: "POST" }),
    );
    assertEquals(post.status, 405);
    assertEquals(post.headers.get("allow"), "GET, HEAD");
  });
});

Deno.test("serves only known UI assets with correct content types", async () => {
  await withAssets(async (_root, handler) => {
    for (
      const [path, type, content] of [
        ["/", "text/html; charset=utf-8", "<title>collab</title>"],
        ["/index.html", "text/html; charset=utf-8", "<title>collab</title>"],
        ["/app.js", "text/javascript; charset=utf-8", "console.log"],
        ["/app.css", "text/css; charset=utf-8", "color: black"],
      ]
    ) {
      const response = await handler(new Request(`http://localhost${path}`));
      assertEquals(response.status, 200, path);
      assertEquals(response.headers.get("content-type"), type, path);
      assert(
        response.headers.get("x-content-type-options") === "nosniff",
        path,
      );
      assert((await response.text()).includes(content), path);
    }

    const head = await handler(
      new Request("http://localhost/app.js", { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");
    assert(Number(head.headers.get("content-length")) > 0);
  });
});

Deno.test("does not decode or serve traversal and unknown paths", async () => {
  await withAssets(async (_root, handler) => {
    for (
      const path of [
        "/secret",
        "/..%2Fsecret",
        "/%2e%2e%2fsecret",
        "/app.js/extra",
      ]
    ) {
      const response = await handler(new Request(`http://localhost${path}`));
      assertEquals(response.status, 404, path);
    }
  });
});

Deno.test("enforces static asset size limit and handles missing assets without leaking paths", async () => {
  await withAssets(async (root, handler) => {
    await Deno.writeTextFile(`${root}/app.js`, "0123456789");
    const tooLarge = await handler(new Request("http://localhost/app.js"));
    assertEquals(tooLarge.status, 413);
    assert(!(await tooLarge.text()).includes(root));

    await Deno.remove(`${root}/app.css`);
    const missing = await handler(new Request("http://localhost/app.css"));
    assertEquals(missing.status, 404);
  }, { maxStaticBytes: 5 });
});

Deno.test("websocket endpoint enforces method, upgrade, and exact offered collab.v1 token", async () => {
  await withAssets(async (_root, handler) => {
    const post = await handler(
      new Request("http://localhost/v1", { method: "POST" }),
    );
    assertEquals(post.status, 405);
    assertEquals(post.headers.get("allow"), "GET");

    const plain = await handler(new Request("http://localhost/v1"));
    assertEquals(plain.status, 426);
    assertEquals(plain.headers.get("upgrade"), "websocket");

    const wrongProtocol = await handler(
      new Request("http://localhost/v1", {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "not-collab.v1",
        },
      }),
    );
    assertEquals(wrongProtocol.status, 400);
  });
});

Deno.test("ephemeral server negotiates collab.v1 and injects a bounded session", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/index.html`, "ok");
  await Deno.writeTextFile(`${root}/app.js`, "ok");
  await Deno.writeTextFile(`${root}/app.css`, "ok");

  let connected: CollabSession | undefined;
  let received: string | Uint8Array | undefined;
  let resolveMessage!: () => void;
  const messageSeen = new Promise<void>((resolve) => resolveMessage = resolve);
  const sessions: CollabSessionHandler = {
    onConnect(session) {
      connected = session;
      session.send("ready");
    },
    onMessage(_session, message) {
      received = message;
      resolveMessage();
    },
  };

  const server = serveHttp({
    staticRoot: root,
    sessions,
    port: 0,
    onListen() {},
  });
  try {
    const address = server.addr as Deno.NetAddr;
    assertEquals(address.hostname, "127.0.0.1");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1`, [
      "other",
      "collab.v1",
    ]);
    const firstMessage = new Promise<MessageEvent>((resolve, reject) => {
      socket.onmessage = resolve;
      socket.onerror = () => reject(new Error("websocket connection failed"));
    });
    const event = await firstMessage;
    assertEquals(socket.protocol, "collab.v1");
    assertEquals(event.data, "ready");
    socket.send("hello");
    await messageSeen;
    assertEquals(received, "hello");
    assert(connected);
    assertEquals(connected.request.url, `http://127.0.0.1:${address.port}/v1`);
    socket.close();
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("oversized websocket messages close with 1009 before reaching the session handler", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/index.html`, "ok");
  await Deno.writeTextFile(`${root}/app.js`, "ok");
  await Deno.writeTextFile(`${root}/app.css`, "ok");
  let delivered = false;
  const sessions: CollabSessionHandler = {
    onConnect() {},
    onMessage() {
      delivered = true;
    },
  };
  const server = serveHttp({
    staticRoot: root,
    sessions,
    maxWebSocketMessageBytes: 4,
    port: 0,
    onListen() {},
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1`, "collab.v1");
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket connection failed"));
    });
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.onclose = resolve
    );
    socket.send("12345");
    const event = await closed;
    assertEquals(event.code, 1009);
    assertEquals(delivered, false);
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
