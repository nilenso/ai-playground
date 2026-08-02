import * as Automerge from "@automerge/automerge";
import { assert } from "./test_support.ts";
import {
  createEditorDocument,
  loadEditorDocument,
  receiveSync,
  replaceFilename,
  replaceMarkdown,
  saveEditorDocument,
  sendSync,
} from "./automerge_doc.ts";

Deno.test("markdown changes synchronize through Automerge messages", () => {
  let left = createEditorDocument("draft.md", "hello");
  let right = {
    doc: Automerge.clone(left.doc),
    syncState: Automerge.initSyncState(),
  };
  left = { ...left, doc: replaceMarkdown(left.doc, "hello world") };

  for (let index = 0; index < 8; index += 1) {
    const outbound = sendSync(left);
    left = outbound.state;
    if (outbound.message) right = receiveSync(right, outbound.message);
    const response = sendSync(right);
    right = response.state;
    if (response.message) left = receiveSync(left, response.message);
    if (!outbound.message && !response.message) break;
  }

  assert(
    Automerge.toJS(right.doc).markdown === "hello world",
    "peer should receive markdown",
  );
  assert(
    Automerge.toJS(right.doc).filename === "draft.md",
    "peer should receive basename",
  );
});

Deno.test("documents save and load as bytes", () => {
  const original = createEditorDocument("draft.md", "hello");
  const bytes = saveEditorDocument(original.doc);
  assert(bytes instanceof Uint8Array, "save should return Uint8Array");
  const loaded = loadEditorDocument(bytes);
  assert(
    Automerge.toJS(loaded.doc).markdown === "hello",
    "load should restore markdown",
  );
});

Deno.test("synchronized filenames are basenames only", () => {
  let replica = createEditorDocument("/private/notes/draft.md", "hello");
  assert(
    Automerge.toJS(replica.doc).filename === "draft.md",
    "create should strip the path",
  );
  replica = {
    ...replica,
    doc: replaceFilename(replica.doc, "C:\\private\\renamed.md"),
  };
  assert(
    Automerge.toJS(replica.doc).filename === "renamed.md",
    "replace should strip the path",
  );
});
