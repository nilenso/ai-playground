import { LocalDocument } from "./local_document.ts";
import {
  loadEditorDocument,
  receiveSync,
  replaceMarkdown,
  sendSync,
  type SyncReplica,
} from "../../ui/src/automerge_doc.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("browser replica and Deno owner synchronize from the same snapshot", () => {
  const owner = LocalDocument.create("notes.md", "initial");
  let browser: SyncReplica = loadEditorDocument(owner.save());
  browser = {
    ...browser,
    doc: replaceMarkdown(browser.doc, "edited in browser"),
  };

  for (let round = 0; round < 8; round += 1) {
    const outbound = sendSync(browser);
    browser = outbound.state;
    if (!outbound.message) break;
    const response = owner.receiveUiSync(outbound.message);
    if (response) browser = receiveSync(browser, response);
  }

  assertEquals(owner.filename, "notes.md");
  assertEquals(owner.markdown, "edited in browser");
});

Deno.test("synchronized filename never contains a local path", () => {
  const owner = LocalDocument.create("/home/alice/private/notes.md", "safe");
  assertEquals(owner.filename, "notes.md");
});
