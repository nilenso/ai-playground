import * as Automerge from "@automerge/automerge";

export interface EditorDocument extends Record<string, unknown> {
  filename: string;
  markdown: string;
}

function synchronizedBasename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1) || "Untitled";
  if (name !== "Untitled" && !name.endsWith(".md")) {
    throw new Error("only Markdown basenames may be synchronized");
  }
  return name;
}

export class LocalDocument {
  #doc: Automerge.Doc<EditorDocument>;
  #uiSync: Automerge.SyncState = Automerge.initSyncState();

  private constructor(doc: Automerge.Doc<EditorDocument>) {
    this.#doc = doc;
  }

  static create(filename = "Untitled", markdown = ""): LocalDocument {
    return new LocalDocument(Automerge.from<EditorDocument>({
      filename: synchronizedBasename(filename),
      markdown,
    }));
  }

  static load(snapshot: Uint8Array): LocalDocument {
    return new LocalDocument(Automerge.load<EditorDocument>(snapshot));
  }

  get filename(): string {
    return synchronizedBasename(this.#doc.filename);
  }

  get markdown(): string {
    return this.#doc.markdown;
  }

  save(): Uint8Array {
    return Automerge.save(this.#doc);
  }

  replaceFromDisk(filename: string, markdown: string): void {
    this.#doc = Automerge.change(
      this.#doc,
      "open local Markdown file",
      (draft) => {
        draft.filename = synchronizedBasename(filename);
        Automerge.updateText(draft, ["markdown"], markdown);
      },
    );
    this.#uiSync = Automerge.initSyncState();
  }

  receiveUiSync(message: Uint8Array): Uint8Array | null {
    [this.#doc, this.#uiSync] = Automerge.receiveSyncMessage(
      this.#doc,
      this.#uiSync,
      message,
    );
    const [nextState, response] = Automerge.generateSyncMessage(
      this.#doc,
      this.#uiSync,
    );
    this.#uiSync = nextState;
    return response;
  }
}
