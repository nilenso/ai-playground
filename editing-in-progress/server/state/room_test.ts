import {
  OFFLINE_RETENTION_MS,
  RoomPolicy,
  RoomPolicyError,
  validFilename,
} from "./room.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof RoomPolicyError);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("room rejects a duplicate active UUID and reconnects retained owners", () => {
  const room = new RoomPolicy();
  room.connect("owner", "Alice", 10);
  assertCode(() => room.connect("owner", "Other", 11), "DUPLICATE_SESSION");
  room.disconnect("owner", 12);
  room.connect("owner", "Alice Again", 13);
  assertEquals(room.get("owner")?.name, "Alice Again");
  assertEquals(room.get("owner")?.online, true);
});

Deno.test("only an online owner can mutate their document", () => {
  const room = new RoomPolicy();
  room.connect("owner", "Alice", 0);
  room.connect("viewer", "Bob", 0);
  assertCode(
    () =>
      room.updateDocument("viewer", "owner", "notes.md", new Uint8Array([1])),
    "NOT_DOCUMENT_OWNER",
  );
  room.updateDocument("owner", "owner", "notes.md", new Uint8Array([1, 2]));
  assertEquals([...room.get("owner")!.snapshot], [1, 2]);
  room.disconnect("owner", 1);
  assertCode(
    () => room.updateDocument("owner", "owner", "notes.md", new Uint8Array()),
    "OWNER_OFFLINE",
  );
});

Deno.test("viewer grants require both parties online and are released explicitly", () => {
  const room = new RoomPolicy();
  room.connect("owner", "Alice", 0);
  room.connect("viewer", "Bob", 0);
  room.selectDocument("viewer", "owner");
  assert(room.canRead("viewer", "owner"));
  room.releaseDocument("viewer", "owner");
  assert(!room.canRead("viewer", "owner"));
  room.disconnect("owner", 1);
  assertCode(() => room.selectDocument("viewer", "owner"), "OWNER_OFFLINE");
});

Deno.test("offline owners expire at 30 minutes and viewer references are cleaned", () => {
  const room = new RoomPolicy();
  room.connect("owner", "Alice", 0);
  room.connect("viewer", "Bob", 0);
  room.selectDocument("viewer", "owner");
  room.disconnect("viewer", 5);
  assertEquals(room.expire(5 + OFFLINE_RETENTION_MS - 1), []);
  assert(room.canRead("viewer", "owner"));
  assertEquals(room.expire(5 + OFFLINE_RETENTION_MS), ["viewer"]);
  assert(!room.canRead("viewer", "owner"));
});

Deno.test("filenames are safe basenames ending in .md or exactly Untitled", () => {
  for (const name of ["Untitled", "notes.md", "résumé.md"]) {
    assert(validFilename(name));
  }
  for (
    const name of [
      "",
      "notes.txt",
      "/tmp/a.md",
      "a/b.md",
      "a\\b.md",
      ".md/evil",
    ]
  ) {
    assert(!validFilename(name), name);
  }
});
