import * as Automerge from "@automerge/automerge";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  MessageType,
  PayloadCursor,
  PayloadWriter,
} from "../core/protocol.ts";
import {
  type Challenge,
  formatServerFinal,
  formatServerFirst,
  parseClientFinal,
  parseClientFirst,
  ServerSession,
} from "../core/scram.ts";
import { formatUuid, generateUuidV4, parseUuidV4 } from "../core/uuid.ts";
import { errorDetails, log } from "../log.ts";
import { RoomPolicy } from "../state/room.ts";

export interface CoordinatorSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface CoordinatorOptions {
  secret: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  room?: RoomPolicy;
  now?: () => number;
}

type ConnectionPhase =
  | "waiting-first"
  | "waiting-proof"
  | "waiting-confirm"
  | "ready"
  | "closed";
interface ConnectionState {
  phase: ConnectionPhase;
  auth?: ServerSession;
  challenge?: Challenge;
  instanceId?: string;
  queue: Promise<void>;
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function stringPayload(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return new PayloadWriter(2 + bytes.length).writeString(value).bytes();
}

function presencePayload(
  id: string,
  name: string,
  filename: string,
  online: boolean,
  lastSeenMs: number,
): Uint8Array {
  const size = 16 + 2 + new TextEncoder().encode(name).length + 2 +
    new TextEncoder().encode(filename).length + 1 + 8;
  return new PayloadWriter(size)
    .writeUuid(parseUuidV4(id))
    .writeString(name)
    .writeString(filename)
    .writeU8(online ? 1 : 0)
    .writeU64(BigInt(lastSeenMs))
    .bytes();
}

export class Coordinator {
  readonly room: RoomPolicy;
  readonly roomId = formatUuid(generateUuidV4());
  readonly serverEpoch = formatUuid(generateUuidV4());
  #secret: Uint8Array;
  #salt: Uint8Array;
  #iterations: number;
  #now: () => number;
  #connections = new Map<CoordinatorSocket, ConnectionState>();
  #online = new Map<string, CoordinatorSocket>();
  #expiryTimer?: number;

  constructor(options: CoordinatorOptions) {
    this.#secret = options.secret.slice();
    this.#salt = options.salt.slice();
    this.#iterations = options.iterations;
    this.room = options.room ?? new RoomPolicy();
    this.#now = options.now ?? Date.now;
  }

  connect(socket: CoordinatorSocket): void {
    const state: ConnectionState = {
      phase: "waiting-first",
      queue: Promise.resolve(),
    };
    this.#connections.set(socket, state);
    log.info("coordinator", "websocket client connected", {
      activeConnections: this.#connections.size,
    });
    const writer = new PayloadWriter(68)
      .writeUuid(parseUuidV4(this.serverEpoch))
      .writeUuid(parseUuidV4(this.roomId))
      .writeUuid(generateUuidV4())
      .writeU32(16 * 1024 * 1024)
      .writeU32(8 * 1024 * 1024)
      .writeU32(64 * 1024 * 1024)
      .writeU32(1800)
      .writeU32(10_000);
    socket.send(encodeFrame(MessageType.server_hello, 0, writer.bytes()));
  }

  receive(
    socket: CoordinatorSocket,
    message: string | Uint8Array,
  ): Promise<void> {
    const state = this.#connections.get(socket);
    if (!state || state.phase === "closed") return Promise.resolve();
    state.queue = state.queue.then(async () => {
      if (typeof message === "string") {
        throw new Error("binary messages required");
      }
      await this.#handle(socket, state, decodeFrame(message));
    }).catch((error) =>
      this.#fail(socket, state, 1002, "protocol error", error)
    );
    return state.queue;
  }

  disconnect(socket: CoordinatorSocket): void {
    const state = this.#connections.get(socket);
    if (!state || state.phase === "closed") return;
    const previousPhase = state.phase;
    state.phase = "closed";
    this.#connections.delete(socket);
    if (state.instanceId && this.#online.get(state.instanceId) === socket) {
      this.#online.delete(state.instanceId);
      const now = this.#now();
      this.room.disconnect(state.instanceId, now);
      this.#broadcast(
        MessageType.owner_offline,
        presencePayload(
          state.instanceId,
          this.room.get(state.instanceId)?.name ?? "",
          this.room.get(state.instanceId)?.filename ?? "Untitled",
          false,
          now,
        ),
      );
    }
    log.info("coordinator", "websocket client disconnected", {
      instanceId: state.instanceId ?? "not authenticated",
      previousPhase,
      activeConnections: this.#connections.size,
    });
  }

  startExpiryTimer(intervalMs = 1000): void {
    if (this.#expiryTimer !== undefined) return;
    this.#expiryTimer = setInterval(() => this.expire(), intervalMs);
  }

  stopExpiryTimer(): void {
    if (this.#expiryTimer !== undefined) clearInterval(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  expire(): string[] {
    const now = this.#now();
    const retained: Array<{ id: string; viewers: string[] }> = [];
    for (const owner of this.room.users()) {
      const id = owner.id;
      if (
        owner && !owner.online && owner.disconnectedAtMs !== null &&
        now - owner.disconnectedAtMs >= 30 * 60 * 1000
      ) {
        retained.push({ id, viewers: [...owner.viewers] });
      }
    }
    const expired = this.room.expire(now);
    for (const owner of retained) {
      if (!expired.includes(owner.id)) continue;
      const payload = new PayloadWriter(16).writeUuid(parseUuidV4(owner.id))
        .bytes();
      for (const viewerId of owner.viewers) {
        this.#sendTo(viewerId, MessageType.view_expired, 0, payload);
      }
    }
    return expired;
  }

  async #handle(
    socket: CoordinatorSocket,
    state: ConnectionState,
    frame: Frame,
  ): Promise<void> {
    if (state.phase === "waiting-first") {
      if (
        frame.messageType !== MessageType.auth_client_first ||
        frame.requestId === 0
      ) throw new Error("unexpected message");
      const cursor = new PayloadCursor(frame.payload);
      const first = parseClientFirst(cursor.readString());
      cursor.finish();
      const auth = new ServerSession(
        this.#secret,
        this.#salt,
        this.#iterations,
      );
      const challenge = await auth.begin(
        first.instanceId,
        first.nonce,
        nonce(),
      );
      state.auth = auth;
      state.challenge = challenge;
      state.instanceId = first.instanceId;
      state.phase = "waiting-proof";
      log.debug("coordinator", "received SCRAM client-first", {
        instanceId: first.instanceId,
      });
      socket.send(
        encodeFrame(
          MessageType.auth_server_first,
          frame.requestId,
          stringPayload(formatServerFirst(challenge)),
        ),
      );
      return;
    }
    if (state.phase === "waiting-proof") {
      if (
        frame.messageType !== MessageType.auth_client_final ||
        frame.requestId === 0 || !state.auth || !state.challenge
      ) throw new Error("unexpected message");
      const cursor = new PayloadCursor(frame.payload);
      const proof = parseClientFinal(cursor.readString(), state.challenge);
      cursor.finish();
      const signature = state.auth.finish(proof);
      state.phase = "waiting-confirm";
      socket.send(
        encodeFrame(
          MessageType.auth_server_final,
          frame.requestId,
          stringPayload(formatServerFinal(signature)),
        ),
      );
      return;
    }
    if (state.phase === "waiting-confirm") {
      if (
        frame.messageType !== MessageType.auth_confirm ||
        frame.requestId === 0 || frame.payload.length !== 0 || !state.auth ||
        !state.instanceId
      ) throw new Error("unexpected message");
      state.auth.confirm();
      this.room.connect(state.instanceId, "Anonymous", this.#now());
      this.#online.set(state.instanceId, socket);
      state.phase = "ready";
      log.info("coordinator", "client authentication completed", {
        instanceId: state.instanceId,
        onlineClients: this.#online.size,
      });
      socket.send(
        encodeFrame(MessageType.ready, frame.requestId, new Uint8Array()),
      );
      return;
    }
    if (
      state.phase !== "ready" || !state.instanceId ||
      !state.auth?.canAcceptApplication
    ) throw new Error("application before authentication");
    switch (frame.messageType) {
      case MessageType.list_online:
        this.#sendOnlineList(socket, frame.requestId, state.instanceId);
        break;
      case MessageType.owner_update:
        this.#ownerUpdate(socket, frame, state.instanceId);
        break;
      case MessageType.select_view:
        this.#selectView(socket, frame, state.instanceId);
        break;
      case MessageType.release_view:
        this.#releaseView(frame, state.instanceId);
        break;
      default:
        throw new Error("unexpected application message");
    }
  }

  #ownerUpdate(
    socket: CoordinatorSocket,
    frame: Frame,
    instanceId: string,
  ): void {
    const cursor = new PayloadCursor(frame.payload);
    const name = cursor.readString();
    const filename = cursor.readString();
    const snapshot = cursor.readBlob();
    cursor.finish();
    if (snapshot.length > 8 * 1024 * 1024) {
      throw new Error("snapshot too large");
    }
    Automerge.load(snapshot);
    this.room.updateOwnedDocument(instanceId, name, filename, snapshot);
    socket.send(
      encodeFrame(MessageType.op_ack, frame.requestId, new Uint8Array()),
    );
    const user = this.room.get(instanceId)!;
    this.#broadcast(
      MessageType.peer_online,
      presencePayload(
        instanceId,
        user.name,
        user.filename,
        true,
        user.lastSeenMs,
      ),
      instanceId,
    );
    const ownerState = new PayloadWriter(
      16 + 2 + 80 + 2 + 255 + 4 + user.snapshot.length,
    )
      .writeUuid(parseUuidV4(instanceId))
      .writeString(user.name)
      .writeString(user.filename)
      .writeBlob(user.snapshot)
      .bytes();
    for (const viewerId of user.viewers) {
      this.#sendTo(viewerId, MessageType.owner_state, 0, ownerState);
    }
  }

  #sendOnlineList(
    socket: CoordinatorSocket,
    requestId: number,
    ownId: string,
  ): void {
    const users = [...this.#online.keys()].filter((id) => id !== ownId).map((
      id,
    ) => this.room.get(id)!).filter(Boolean);
    const capacity = 2 +
      users.reduce(
        (total, user) =>
          total +
          presencePayload(
            user.id,
            user.name,
            user.filename,
            true,
            user.lastSeenMs,
          ).length,
        0,
      );
    const writer = new PayloadWriter(capacity).writeU16(users.length);
    for (const user of users) {
      writer.writeUuid(parseUuidV4(user.id)).writeString(user.name).writeString(
        user.filename,
      ).writeU8(1).writeU64(BigInt(user.lastSeenMs));
    }
    socket.send(
      encodeFrame(MessageType.online_list, requestId, writer.bytes()),
    );
  }

  #selectView(socket: CoordinatorSocket, frame: Frame, viewerId: string): void {
    const cursor = new PayloadCursor(frame.payload);
    const ownerId = formatUuid(cursor.readUuid());
    cursor.finish();
    this.room.selectDocument(viewerId, ownerId);
    const owner = this.room.get(ownerId)!;
    const writer = new PayloadWriter(
      16 + 2 + 80 + 2 + 255 + 4 + owner.snapshot.length,
    )
      .writeUuid(parseUuidV4(ownerId)).writeString(owner.name).writeString(
        owner.filename,
      ).writeBlob(owner.snapshot);
    socket.send(
      encodeFrame(MessageType.view_selected, frame.requestId, writer.bytes()),
    );
  }

  #releaseView(frame: Frame, viewerId: string): void {
    const cursor = new PayloadCursor(frame.payload);
    const ownerId = formatUuid(cursor.readUuid());
    cursor.finish();
    this.room.releaseDocument(viewerId, ownerId);
  }

  #broadcast(type: MessageType, payload: Uint8Array, exceptId?: string): void {
    for (const [id, socket] of this.#online) {
      if (id !== exceptId) socket.send(encodeFrame(type, 0, payload));
    }
  }

  #sendTo(
    id: string,
    type: MessageType,
    requestId: number,
    payload: Uint8Array,
  ): void {
    const socket = this.#online.get(id);
    if (socket) socket.send(encodeFrame(type, requestId, payload));
  }

  #fail(
    socket: CoordinatorSocket,
    state: ConnectionState,
    code: number,
    reason: string,
    error: unknown,
  ): void {
    log.error("coordinator", "closing client after protocol failure", {
      ...errorDetails(error),
      instanceId: state.instanceId ?? "not authenticated",
      phase: state.phase,
      closeCode: code,
      closeReason: reason,
    });
    socket.close(code, reason);
    this.disconnect(socket);
  }
}
