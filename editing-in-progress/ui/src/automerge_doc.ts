import * as Automerge from "@automerge/automerge";
import { basename } from "./state.ts";

export interface EditorDocument extends Record<string, unknown> {
  filename: string;
  markdown: string;
}

export interface SyncReplica {
  doc: Automerge.Doc<EditorDocument>;
  syncState: Automerge.SyncState;
}

export interface OutboundSync {
  state: SyncReplica;
  message: Uint8Array | null;
}

export function createEditorDocument(
  filename: string,
  markdown: string,
): SyncReplica {
  return {
    doc: Automerge.from<EditorDocument>({
      filename: basename(filename),
      markdown,
    }),
    syncState: Automerge.initSyncState(),
  };
}

export function saveEditorDocument(
  doc: Automerge.Doc<EditorDocument>,
): Uint8Array {
  return Automerge.save(doc);
}

export function loadEditorDocument(bytes: Uint8Array): SyncReplica {
  return {
    doc: Automerge.load<EditorDocument>(bytes),
    syncState: Automerge.initSyncState(),
  };
}

export function replaceMarkdown(
  doc: Automerge.Doc<EditorDocument>,
  markdown: string,
): Automerge.Doc<EditorDocument> {
  return Automerge.change(doc, "edit markdown", (draft) => {
    Automerge.updateText(draft, ["markdown"], markdown);
  });
}

export function replaceFilename(
  doc: Automerge.Doc<EditorDocument>,
  filename: string,
): Automerge.Doc<EditorDocument> {
  return Automerge.change(doc, "switch file", (draft) => {
    draft.filename = basename(filename);
  });
}

export function sendSync(replica: SyncReplica): OutboundSync {
  const [syncState, message] = Automerge.generateSyncMessage(
    replica.doc,
    replica.syncState,
  );
  return { state: { doc: replica.doc, syncState }, message };
}

export function receiveSync(
  replica: SyncReplica,
  message: Uint8Array,
): SyncReplica {
  const [doc, syncState] = Automerge.receiveSyncMessage(
    replica.doc,
    replica.syncState,
    message,
  );
  return { doc, syncState };
}
