import { basename, nextRecent } from "./state.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("basename never exposes a local path", () => {
  assertEquals(basename("/home/alice/private/notes.md"), "notes.md");
  assertEquals(basename("C:\\Users\\Alice\\draft.md"), "draft.md");
  assertEquals(basename(""), "Untitled");
});

Deno.test("recent files are unique, newest first, and bounded", () => {
  const recent = nextRecent(["/a.md", "/b.md", "/c.md"], "/b.md", 3);
  assertEquals(recent, ["/b.md", "/a.md", "/c.md"]);
  assertEquals(nextRecent(recent, "/d.md", 3), ["/d.md", "/b.md", "/a.md"]);
});
