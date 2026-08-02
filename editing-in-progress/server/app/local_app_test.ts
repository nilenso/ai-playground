import * as Automerge from "@automerge/automerge";
import { LocalApplication } from "./local_app.ts";
import type { EditorDocument } from "./local_document.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("local app opens, saves, and exposes only a basename in document state", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/private-notes.md`;
    await Deno.writeTextFile(path, "initial");
    const app = new LocalApplication(
      "123e4567-e89b-42d3-a456-426614174000",
      "Alice",
    );
    const opened = await app.open(path);
    assertEquals(opened.filename, "private-notes.md");
    assertEquals(opened.markdown, "initial");
    const saved = await app.save(path, "changed");
    assertEquals(await Deno.readTextFile(path), "changed");
    const bytes = Uint8Array.from(
      atob(saved.snapshotBase64),
      (character) => character.charCodeAt(0),
    );
    const document = Automerge.load<EditorDocument>(bytes);
    assertEquals(document.filename, "private-notes.md");
    assertEquals(document.markdown, "changed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("untitled save fails closed without a local path", async () => {
  const app = new LocalApplication(
    "123e4567-e89b-42d3-a456-426614174000",
    "Alice",
  );
  let failed = false;
  try {
    await app.save(null, "draft");
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("untitled save unexpectedly succeeded");
});
