import { normalizeBootstrapState, toUint8Array } from "./bridge.ts";
import { assert } from "./test_support.ts";

Deno.test("binary API values normalize to Uint8Array", () => {
  const expected = [1, 2, 255];
  assert(
    JSON.stringify([...toUint8Array(expected)]) === JSON.stringify(expected),
    "array should normalize",
  );
  assert(
    JSON.stringify([...toUint8Array(new Uint8Array(expected).buffer)]) ===
      JSON.stringify(expected),
    "ArrayBuffer should normalize",
  );
});

Deno.test("bootstrap state exposes basenames for synchronized filenames", () => {
  const state = normalizeBootstrapState({
    instanceId: "one",
    name: "Alice",
    filename: "/private/local.md",
    path: "/private/local.md",
    markdown: "hello",
    recentFiles: ["/private/local.md"],
    status: "online",
    peers: [{
      id: "two",
      name: "Bob",
      filename: "C:\\private\\remote.md",
      online: true,
      lastSeen: 0,
      selectable: true,
    }],
  });
  assert(
    state.filename === "local.md",
    "local synchronized name should be a basename",
  );
  assert(
    state.peers[0]?.filename === "remote.md",
    "peer synchronized name should be a basename",
  );
  assert(
    state.path === "/private/local.md",
    "the local path must remain available for local persistence",
  );
});
