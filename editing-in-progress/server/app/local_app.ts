import * as Automerge from "@automerge/automerge";
import { type EditorDocument, LocalDocument } from "./local_document.ts";

const maxMarkdownBytes = 8 * 1024 * 1024;

export type ConnectionStatus = "online" | "connecting" | "disconnected";
export interface PeerPresence {
  id: string;
  name: string;
  filename: string;
  online: boolean;
  selectable: boolean;
  lastSeen: number;
}
export interface BootstrapState {
  instanceId: string;
  name: string;
  filename: string;
  path: string | null;
  markdown: string;
  snapshotBase64: string;
  recentFiles: string[];
  status: ConnectionStatus;
  peers: PeerPresence[];
}
export interface RemoteCoordinator {
  updateOwner(
    name: string,
    filename: string,
    snapshot: Uint8Array,
  ): Promise<void>;
  selectPeer(
    id: string,
  ): Promise<
    { ownerId: string; name: string; filename: string; snapshot: Uint8Array }
  >;
  releasePeer(id: string): void;
}
export interface LocalPersistence {
  touchLocal(path: string): Promise<void>;
  scheduleRecovery(
    snapshot: Uint8Array,
    dirty: boolean,
    unsynced: boolean,
  ): void;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
function validateLocalMarkdownPath(path: string): void {
  if (!path.startsWith("/") || path.includes("\0") || !path.endsWith(".md")) {
    throw new Error("path must be an absolute local .md path");
  }
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export class LocalApplication {
  readonly instanceId: string;
  #name: string;
  #path: string | null = null;
  #document: LocalDocument;
  #recentFiles: string[] = [];
  #status: ConnectionStatus = "disconnected";
  #peers = new Map<string, PeerPresence>();
  #events = new Set<WebSocket>();
  #coordinator?: RemoteCoordinator;
  #selectedPeer?: string;
  #persistence?: LocalPersistence;
  #dirty = false;
  #unsynced = false;

  constructor(
    instanceId: string,
    name: string,
    document = LocalDocument.create(),
    recentFiles: string[] = [],
    persistence?: LocalPersistence,
    recoveryFlags: { dirty: boolean; unsynced: boolean } = {
      dirty: false,
      unsynced: false,
    },
  ) {
    this.instanceId = instanceId;
    this.#name = name;
    this.#document = document;
    this.#recentFiles = [...recentFiles];
    this.#persistence = persistence;
    this.#dirty = recoveryFlags.dirty;
    this.#unsynced = recoveryFlags.unsynced;
  }

  setCoordinator(coordinator: RemoteCoordinator): void {
    this.#coordinator = coordinator;
  }

  ownerSnapshot(): Uint8Array {
    return this.#document.save();
  }

  bootstrap(): BootstrapState {
    return {
      instanceId: this.instanceId,
      name: this.#name,
      filename: this.#document.filename,
      path: this.#path,
      markdown: this.#document.markdown,
      snapshotBase64: encodeBase64(this.#document.save()),
      recentFiles: [...this.#recentFiles],
      status: this.#status,
      peers: [...this.#peers.values()].map((peer) => ({
        ...peer,
        filename: basename(peer.filename),
      })),
    };
  }

  async open(path: string): Promise<BootstrapState> {
    validateLocalMarkdownPath(path);
    let markdown = "";
    try {
      const info = await Deno.stat(path);
      if (!info.isFile || info.size > maxMarkdownBytes) {
        throw new Error("Markdown file is too large");
      }
      markdown = await Deno.readTextFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#path = path;
    this.#document = LocalDocument.create(basename(path), markdown);
    this.#touchRecent(path);
    this.#dirty = false;
    this.#unsynced = true;
    this.#scheduleRecovery();
    await this.#persistence?.touchLocal(path);
    await this.#publishOwner();
    this.#publish({ type: "state", state: this.bootstrap() });
    return this.bootstrap();
  }

  async save(path: string | null, markdown: string): Promise<BootstrapState> {
    const destination = path || this.#path;
    if (!destination) {
      throw new Error("save-as path is required for an untitled document");
    }
    validateLocalMarkdownPath(destination);
    if (new TextEncoder().encode(markdown).length > maxMarkdownBytes) {
      throw new Error("Markdown file is too large");
    }
    this.#document.replaceFromDisk(basename(destination), markdown);
    const temporary =
      `${destination}.editing-in-progress-${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temporary, markdown, {
        create: true,
        mode: 0o600,
      });
      await Deno.rename(temporary, destination);
    } catch (error) {
      await Deno.remove(temporary).catch(() => {});
      throw error;
    }
    this.#path = destination;
    this.#touchRecent(destination);
    this.#dirty = false;
    this.#unsynced = true;
    this.#scheduleRecovery();
    await this.#persistence?.touchLocal(destination);
    await this.#publishOwner();
    return this.bootstrap();
  }

  async rename(name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized || new TextEncoder().encode(normalized).length > 80) {
      throw new Error("name must contain 1 to 80 UTF-8 bytes");
    }
    this.#name = normalized;
    await this.#publishOwner();
  }

  receiveUiSync(filename: string, message: Uint8Array): Uint8Array | null {
    if (basename(filename) !== this.#document.filename) {
      throw new Error("sync filename does not match current document");
    }
    const response = this.#document.receiveUiSync(message);
    this.#dirty = true;
    this.#unsynced = true;
    this.#scheduleRecovery();
    void this.#publishOwner();
    return response;
  }

  async selectPeer(
    id: string,
  ): Promise<{ filename: string; markdown: string }> {
    const peer = this.#peers.get(id);
    if (!peer?.online || !peer.selectable) {
      throw new Error("peer is not selectable");
    }
    if (!this.#coordinator) throw new Error("coordinator is unavailable");
    if (this.#selectedPeer && this.#selectedPeer !== id) {
      this.#coordinator.releasePeer(this.#selectedPeer);
    }
    const remote = await this.#coordinator.selectPeer(id);
    const document = Automerge.load<EditorDocument>(remote.snapshot);
    this.#selectedPeer = id;
    return { filename: remote.filename, markdown: document.markdown };
  }

  attachEvents(socket: WebSocket): void {
    this.#events.add(socket);
    socket.addEventListener("close", () => this.#events.delete(socket), {
      once: true,
    });
  }
  setConnectionStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#publish({ type: "connection", status });
  }
  replacePresence(peers: PeerPresence[]): void {
    this.#peers = new Map(peers.map((peer) => [peer.id, { ...peer }]));
    this.#publish({ type: "presence", peers: [...this.#peers.values()] });
  }
  updatePresence(peer: PeerPresence): void {
    this.#peers.set(peer.id, { ...peer });
    this.#publish({ type: "presence", peers: [...this.#peers.values()] });
  }
  expireRemote(ownerId: string): void {
    if (this.#selectedPeer === ownerId) {
      this.#selectedPeer = undefined;
      this.#publish({ type: "view-expired", ownerId });
    }
  }

  updateRemote(
    ownerId: string,
    name: string,
    filename: string,
    snapshot: Uint8Array,
  ): void {
    if (this.#selectedPeer !== ownerId) return;
    const remote = Automerge.load<EditorDocument>(snapshot);
    this.#publish({
      type: "remote-state",
      ownerId,
      name,
      filename: basename(filename),
      markdown: remote.markdown,
    });
  }

  #touchRecent(path: string): void {
    this.#recentFiles = [
      path,
      ...this.#recentFiles.filter((candidate) => candidate !== path),
    ].slice(0, 16);
  }
  async #publishOwner(): Promise<void> {
    if (!this.#coordinator) return;
    try {
      await this.#coordinator.updateOwner(
        this.#name,
        this.#document.filename,
        this.#document.save(),
      );
      this.#unsynced = false;
      this.#scheduleRecovery();
    } catch {
      this.setConnectionStatus("disconnected");
    }
  }
  #scheduleRecovery(): void {
    this.#persistence?.scheduleRecovery(
      this.#document.save(),
      this.#dirty,
      this.#unsynced,
    );
  }
  #publish(event: unknown): void {
    const message = JSON.stringify(event);
    for (const socket of this.#events) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else this.#events.delete(socket);
    }
  }
}
