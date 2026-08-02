import {
  decodeFrame,
  encodeFrame,
  type Frame,
  MessageType,
  PayloadCursor,
  PayloadWriter,
} from "../core/protocol.ts";
import {
  ClientSession,
  formatClientFinal,
  formatClientFirst,
  parseServerFinal,
  parseServerFirst,
} from "../core/scram.ts";
import { formatUuid, parseUuidV4 } from "../core/uuid.ts";

export type ClientStatus = "online" | "connecting" | "disconnected";
export interface RemotePresence {
  id: string;
  name: string;
  filename: string;
  online: boolean;
  selectable: boolean;
  lastSeen: number;
}
export interface RemoteDocument {
  ownerId: string;
  name: string;
  filename: string;
  snapshot: Uint8Array;
}
export interface CoordinatorClientEvents {
  onStatus?(status: ClientStatus): void;
  onPresence?(peers: RemotePresence[]): void;
  onPeer?(peer: RemotePresence): void;
  onRemoteDocument?(
    ownerId: string,
    name: string,
    filename: string,
    snapshot: Uint8Array,
  ): void;
  onViewExpired?(ownerId: string): void;
}
export interface CoordinatorClientOptions {
  url: string;
  instanceId: string;
  secret: Uint8Array;
  expectedSalt: Uint8Array;
  expectedIterations: number;
  events?: CoordinatorClientEvents;
}
interface PendingRequest {
  expected: MessageType;
  resolve(frame: Frame): void;
  reject(error: Error): void;
  timer: number;
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}
function validateUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol === "wss:") return;
  if (
    url.protocol === "ws:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
      url.hostname === "::1")
  ) return;
  throw new Error("coordinator must use wss:// unless it is loopback");
}
function presence(cursor: PayloadCursor): RemotePresence {
  const id = formatUuid(cursor.readUuid());
  const name = cursor.readString();
  const filename = cursor.readString();
  const online = cursor.readU8() === 1;
  const lastSeenValue = cursor.readU64();
  if (lastSeenValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid last-seen timestamp");
  }
  return {
    id,
    name,
    filename,
    online,
    selectable: online,
    lastSeen: Number(lastSeenValue),
  };
}

export class CoordinatorClient {
  #options: CoordinatorClientOptions;
  #socket?: WebSocket;
  #status: ClientStatus = "disconnected";
  #stopped = true;
  #attempt = 0;
  #requestId = 1;
  #pending = new Map<number, PendingRequest>();
  #clientNonce?: string;
  #clientAuth?: ClientSession;
  #latestOwner?: { name: string; filename: string; snapshot: Uint8Array };

  constructor(options: CoordinatorClientOptions) {
    validateUrl(options.url);
    if (options.secret.length !== 32 || options.expectedSalt.length !== 16) {
      throw new Error("invalid coordinator credentials");
    }
    this.#options = {
      ...options,
      secret: options.secret.slice(),
      expectedSalt: options.expectedSalt.slice(),
    };
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.close(1000, "client stopped");
    this.#socket = undefined;
    this.#rejectPending(new Error("client stopped"));
    this.#setStatus("disconnected");
  }

  async updateOwner(
    name: string,
    filename: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    this.#latestOwner = { name, filename, snapshot: snapshot.slice() };
    if (this.#status !== "online") return;
    const capacity = 2 + new TextEncoder().encode(name).length + 2 +
      new TextEncoder().encode(filename).length + 4 + snapshot.length;
    const payload = new PayloadWriter(capacity).writeString(name).writeString(
      filename,
    ).writeBlob(snapshot).bytes();
    await this.#request(MessageType.owner_update, payload, MessageType.op_ack);
  }

  async listOnline(): Promise<RemotePresence[]> {
    const frame = await this.#request(
      MessageType.list_online,
      new Uint8Array(),
      MessageType.online_list,
    );
    const cursor = new PayloadCursor(frame.payload);
    const count = cursor.readU16();
    const peers: RemotePresence[] = [];
    for (let index = 0; index < count; index += 1) peers.push(presence(cursor));
    cursor.finish();
    this.#options.events?.onPresence?.(peers);
    return peers;
  }

  async selectPeer(id: string): Promise<RemoteDocument> {
    const payload = new PayloadWriter(16).writeUuid(parseUuidV4(id)).bytes();
    const frame = await this.#request(
      MessageType.select_view,
      payload,
      MessageType.view_selected,
    );
    const cursor = new PayloadCursor(frame.payload);
    const ownerId = formatUuid(cursor.readUuid());
    const name = cursor.readString();
    const filename = cursor.readString();
    const snapshot = cursor.readBlob().slice();
    cursor.finish();
    return { ownerId, name, filename, snapshot };
  }

  releasePeer(id: string): void {
    if (this.#status !== "online" || !this.#socket) return;
    const payload = new PayloadWriter(16).writeUuid(parseUuidV4(id)).bytes();
    this.#send(
      encodeFrame(MessageType.release_view, this.#nextRequestId(), payload),
    );
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setStatus("connecting");
    const socket = new WebSocket(this.#options.url, "collab.v1");
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.onmessage = (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) {
          throw new Error("binary frame required");
        }
        void this.#handle(decodeFrame(new Uint8Array(event.data))).catch(() =>
          socket.close(1002, "protocol error")
        );
      } catch {
        socket.close(1002, "protocol error");
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#clientAuth = undefined;
      this.#rejectPending(new Error("coordinator disconnected"));
      this.#setStatus("disconnected");
      if (!this.#stopped) {
        const delay = Math.min(30_000, 250 * 2 ** Math.min(this.#attempt++, 7));
        setTimeout(() => this.#connect(), delay);
      }
    };
    socket.onerror = () => {};
  }

  async #handle(frame: Frame): Promise<void> {
    if (
      frame.messageType === MessageType.server_hello &&
      this.#status === "connecting"
    ) {
      const cursor = new PayloadCursor(frame.payload);
      cursor.readUuid();
      cursor.readUuid();
      cursor.readUuid();
      const maxFrame = cursor.readU32();
      const maxSnapshot = cursor.readU32();
      cursor.readU32();
      const retention = cursor.readU32();
      cursor.readU32();
      cursor.finish();
      if (
        maxFrame !== 16 * 1024 * 1024 || maxSnapshot < 8 * 1024 * 1024 ||
        retention !== 1800
      ) throw new Error("unsupported server limits");
      this.#clientNonce = randomNonce();
      const requestId = this.#nextRequestId();
      this.#send(
        encodeFrame(
          MessageType.auth_client_first,
          requestId,
          new PayloadWriter(96).writeString(
            formatClientFirst(this.#options.instanceId, this.#clientNonce),
          ).bytes(),
        ),
      );
      return;
    }
    if (
      frame.messageType === MessageType.auth_server_first &&
      this.#status === "connecting" && this.#clientNonce
    ) {
      const cursor = new PayloadCursor(frame.payload);
      const challenge = parseServerFirst(
        cursor.readString(),
        this.#options.instanceId,
        this.#clientNonce,
      );
      cursor.finish();
      if (
        !bytesEqual(challenge.salt, this.#options.expectedSalt) ||
        challenge.iterations !== this.#options.expectedIterations
      ) throw new Error("server SCRAM parameters do not match configuration");
      this.#clientAuth = await ClientSession.respond(
        this.#options.secret,
        challenge,
      );
      this.#send(
        encodeFrame(
          MessageType.auth_client_final,
          frame.requestId,
          new PayloadWriter(160).writeString(
            formatClientFinal(challenge, this.#clientAuth.proof),
          ).bytes(),
        ),
      );
      return;
    }
    if (
      frame.messageType === MessageType.auth_server_final &&
      this.#status === "connecting" && this.#clientAuth
    ) {
      const cursor = new PayloadCursor(frame.payload);
      const signature = parseServerFinal(cursor.readString());
      cursor.finish();
      this.#clientAuth.verifyServer(signature);
      if (!this.#clientAuth.canSendApplication) {
        throw new Error("server signature was not verified");
      }
      this.#send(
        encodeFrame(
          MessageType.auth_confirm,
          frame.requestId,
          new Uint8Array(),
        ),
      );
      return;
    }
    if (
      frame.messageType === MessageType.ready &&
      this.#status === "connecting" && this.#clientAuth?.canSendApplication
    ) {
      this.#attempt = 0;
      this.#setStatus("online");
      if (this.#latestOwner) {
        await this.updateOwner(
          this.#latestOwner.name,
          this.#latestOwner.filename,
          this.#latestOwner.snapshot,
        );
      }
      await this.listOnline();
      return;
    }
    if (this.#status !== "online" || !this.#clientAuth?.canSendApplication) {
      throw new Error("application data before mutual authentication");
    }
    const pending = this.#pending.get(frame.requestId);
    if (pending) {
      if (frame.messageType !== pending.expected) {
        throw new Error("unexpected response type");
      }
      clearTimeout(pending.timer);
      this.#pending.delete(frame.requestId);
      pending.resolve(frame);
      return;
    }
    if (frame.requestId !== 0) throw new Error("unsolicited request id");
    if (
      frame.messageType === MessageType.peer_online ||
      frame.messageType === MessageType.owner_offline
    ) {
      const cursor = new PayloadCursor(frame.payload);
      const peer = presence(cursor);
      cursor.finish();
      this.#options.events?.onPeer?.(peer);
      return;
    }
    if (frame.messageType === MessageType.view_expired) {
      const cursor = new PayloadCursor(frame.payload);
      const ownerId = formatUuid(cursor.readUuid());
      cursor.finish();
      this.#options.events?.onViewExpired?.(ownerId);
      return;
    }
    if (frame.messageType === MessageType.owner_state) {
      const cursor = new PayloadCursor(frame.payload);
      const ownerId = formatUuid(cursor.readUuid());
      const name = cursor.readString();
      const filename = cursor.readString();
      const snapshot = cursor.readBlob();
      cursor.finish();
      this.#options.events?.onRemoteDocument?.(
        ownerId,
        name,
        filename,
        snapshot,
      );
      return;
    }
    throw new Error("unexpected unsolicited frame");
  }

  #request(
    type: MessageType,
    payload: Uint8Array,
    expected: MessageType,
  ): Promise<Frame> {
    if (
      this.#status !== "online" || !this.#socket ||
      !this.#clientAuth?.canSendApplication
    ) return Promise.reject(new Error("coordinator is offline"));
    const requestId = this.#nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("coordinator request timed out"));
      }, 10_000);
      this.#pending.set(requestId, { expected, resolve, reject, timer });
      this.#send(encodeFrame(type, requestId, payload));
    });
  }

  #nextRequestId(): number {
    const result = this.#requestId;
    this.#requestId = this.#requestId === 0xffffffff ? 1 : this.#requestId + 1;
    return result;
  }

  #send(frame: Uint8Array): void {
    if (!this.#socket) throw new Error("coordinator socket is unavailable");
    this.#socket.send(new Uint8Array(frame).buffer);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setStatus(status: ClientStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.events?.onStatus?.(status);
  }
}
