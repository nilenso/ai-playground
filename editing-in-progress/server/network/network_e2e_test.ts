import * as Automerge from "@automerge/automerge";
import { type CollabSession, createHttpHandler } from "../http/mod.ts";
import { type EditorDocument, LocalDocument } from "../app/local_document.ts";
import { encodeFrame, MessageType } from "../core/protocol.ts";
import { Coordinator } from "./coordinator.ts";
import { CoordinatorClient } from "./client.ts";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

Deno.test("two Deno clients mutually authenticate and share owner snapshots read-only", async () => {
  const secret = new Uint8Array(32).fill(0x5a);
  const salt = new Uint8Array(16).fill(0x19);
  const coordinator = new Coordinator({ secret, salt, iterations: 4096 });
  const sessions = {
    onConnect: (session: CollabSession) => coordinator.connect(session),
    onMessage: (session: CollabSession, message: string | Uint8Array) =>
      coordinator.receive(session, message),
    onClose: (session: CollabSession) => coordinator.disconnect(session),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    createHttpHandler({ sessions, maxWebSocketMessageBytes: 16 * 1024 * 1024 }),
  );
  const port = (server.addr as Deno.NetAddr).port;
  let aliceOnline = false;
  let bobOnline = false;
  let pushedMarkdown = "";
  const alice = new CoordinatorClient({
    url: `ws://127.0.0.1:${port}/v1`,
    instanceId: "d9428888-122b-4fee-9bb0-d7c1651c1f8b",
    secret,
    expectedSalt: salt,
    expectedIterations: 4096,
    events: { onStatus: (status) => aliceOnline = status === "online" },
  });
  const bob = new CoordinatorClient({
    url: `ws://127.0.0.1:${port}/v1`,
    instanceId: "8f14e45f-ea0b-4f5f-a123-0123456789ab",
    secret,
    expectedSalt: salt,
    expectedIterations: 4096,
    events: {
      onStatus: (status) => bobOnline = status === "online",
      onRemoteDocument: (_ownerId, _name, _filename, snapshot) => {
        pushedMarkdown = Automerge.load<EditorDocument>(snapshot).markdown;
      },
    },
  });
  try {
    const document = LocalDocument.create("alice.md", "Hello Bob");
    await alice.updateOwner("Alice", "alice.md", document.save());
    await bob.updateOwner("Bob", "Untitled", LocalDocument.create().save());
    alice.start();
    bob.start();
    await waitFor(() => aliceOnline && bobOnline);
    const peers = await bob.listOnline();
    if (
      !peers.some((peer) =>
        peer.name === "Alice" && peer.filename === "alice.md"
      )
    ) throw new Error("Alice was absent from presence");
    const remote = await bob.selectPeer("d9428888-122b-4fee-9bb0-d7c1651c1f8b");
    const loaded = Automerge.load<EditorDocument>(remote.snapshot);
    if (loaded.markdown !== "Hello Bob") {
      throw new Error("remote snapshot did not match owner state");
    }
    await alice.updateOwner(
      "Alice",
      "alice.md",
      LocalDocument.create("alice.md", "Live update").save(),
    );
    await waitFor(() => pushedMarkdown === "Live update");
  } finally {
    alice.stop();
    bob.stop();
    await server.shutdown();
  }
});

Deno.test("coordinator rejects application frames before SCRAM confirmation", async () => {
  const coordinator = new Coordinator({
    secret: new Uint8Array(32).fill(1),
    salt: new Uint8Array(16).fill(2),
    iterations: 4096,
  });
  const sessions = {
    onConnect: (session: CollabSession) => coordinator.connect(session),
    onMessage: (session: CollabSession, message: string | Uint8Array) =>
      coordinator.receive(session, message),
    onClose: (session: CollabSession) => coordinator.disconnect(session),
  };
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, createHttpHandler({ sessions }));
  const port = (server.addr as Deno.NetAddr).port;
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1`, "collab.v1");
    socket.binaryType = "arraybuffer";
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.onopen = () =>
        socket.send(
          new Uint8Array(
            encodeFrame(MessageType.list_online, 99, new Uint8Array()),
          ).buffer,
        );
      socket.onclose = (event) => resolve(event.code);
      socket.onerror = () =>
        reject(new Error("websocket failed before protocol close"));
    });
    if (closeCode !== 1002) {
      throw new Error(`expected protocol close 1002, got ${closeCode}`);
    }
  } finally {
    await server.shutdown();
  }
});
