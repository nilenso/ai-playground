export const OFFLINE_RETENTION_MS = 30 * 60 * 1000;
export const offlineRetentionMs = OFFLINE_RETENTION_MS;

export type RoomPolicyErrorCode =
  | "DUPLICATE_SESSION"
  | "INVALID_FILENAME"
  | "INVALID_NAME"
  | "NOT_DOCUMENT_OWNER"
  | "OWNER_OFFLINE"
  | "UNKNOWN_USER"
  | "VIEWER_OFFLINE";

export class RoomPolicyError extends Error {
  constructor(readonly code: RoomPolicyErrorCode) {
    super(code);
    this.name = "RoomPolicyError";
  }
}

export interface RoomUser {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
  readonly snapshot: Uint8Array;
  readonly online: boolean;
  readonly lastSeenMs: number;
  readonly disconnectedAtMs: number | null;
  readonly viewers: ReadonlySet<string>;
}

interface MutableRoomUser {
  id: string;
  name: string;
  filename: string;
  snapshot: Uint8Array;
  online: boolean;
  lastSeenMs: number;
  disconnectedAtMs: number | null;
  viewers: Set<string>;
}

function fail(code: RoomPolicyErrorCode): never {
  throw new RoomPolicyError(code);
}

function validName(name: string): boolean {
  return name.length > 0 && new TextEncoder().encode(name).length <= 80;
}

export function validFilename(filename: string): boolean {
  const bytes = new TextEncoder().encode(filename).length;
  return bytes > 0 && bytes <= 255 && filename !== "." && filename !== ".." &&
    !filename.includes("/") && !filename.includes("\\") &&
    (filename === "Untitled" || filename.endsWith(".md"));
}

/** In-memory coordinator policy. This class deliberately performs no persistence. */
export class RoomPolicy {
  #users = new Map<string, MutableRoomUser>();

  get size(): number {
    return this.#users.size;
  }

  get(id: string): RoomUser | undefined {
    const user = this.#users.get(id);
    return user ? this.#copyUser(user) : undefined;
  }

  users(): RoomUser[] {
    return [...this.#users.values()].map((user) => this.#copyUser(user));
  }

  connect(id: string, name: string, nowMs: number): void {
    if (!validName(name)) fail("INVALID_NAME");
    const user = this.#users.get(id);
    if (user) {
      if (user.online) fail("DUPLICATE_SESSION");
      user.name = name;
      user.online = true;
      user.lastSeenMs = nowMs;
      user.disconnectedAtMs = null;
      return;
    }
    this.#users.set(id, {
      id,
      name,
      filename: "Untitled",
      snapshot: new Uint8Array(),
      online: true,
      lastSeenMs: nowMs,
      disconnectedAtMs: null,
      viewers: new Set(),
    });
  }

  disconnect(id: string, nowMs: number): void {
    const user = this.#user(id);
    user.online = false;
    user.lastSeenMs = nowMs;
    user.disconnectedAtMs = nowMs;
  }

  setName(actorId: string, name: string): void {
    if (!validName(name)) fail("INVALID_NAME");
    this.#user(actorId).name = name;
  }

  updateDocument(
    actorId: string,
    ownerId: string,
    filename: string,
    snapshot: Uint8Array,
  ): void {
    if (actorId !== ownerId) fail("NOT_DOCUMENT_OWNER");
    if (!validFilename(filename)) fail("INVALID_FILENAME");
    const owner = this.#user(ownerId);
    if (!owner.online) fail("OWNER_OFFLINE");
    owner.filename = filename;
    owner.snapshot = snapshot.slice();
  }

  updateOwnedDocument(
    actorId: string,
    name: string,
    filename: string,
    snapshot: Uint8Array,
  ): void {
    if (!validName(name)) fail("INVALID_NAME");
    this.updateDocument(actorId, actorId, filename, snapshot);
    this.#user(actorId).name = name;
  }

  selectDocument(viewerId: string, ownerId: string): void {
    const viewer = this.#user(viewerId);
    if (!viewer.online) fail("VIEWER_OFFLINE");
    const owner = this.#user(ownerId);
    if (!owner.online) fail("OWNER_OFFLINE");
    owner.viewers.add(viewerId);
  }

  canRead(viewerId: string, ownerId: string): boolean {
    const owner = this.#users.get(ownerId);
    return owner !== undefined &&
      (viewerId === ownerId || owner.viewers.has(viewerId));
  }

  releaseDocument(viewerId: string, ownerId: string): void {
    this.#users.get(ownerId)?.viewers.delete(viewerId);
  }

  /** Removes retained offline users at the inclusive 30-minute boundary. */
  expire(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [id, user] of this.#users) {
      if (
        user.disconnectedAtMs !== null &&
        nowMs - user.disconnectedAtMs >= OFFLINE_RETENTION_MS
      ) expired.push(id);
    }
    for (const id of expired) {
      this.#users.delete(id);
      for (const user of this.#users.values()) user.viewers.delete(id);
    }
    return expired;
  }

  #user(id: string): MutableRoomUser {
    return this.#users.get(id) ?? fail("UNKNOWN_USER");
  }

  #copyUser(user: MutableRoomUser): RoomUser {
    return {
      ...user,
      snapshot: user.snapshot.slice(),
      viewers: new Set(user.viewers),
    };
  }
}

export { RoomPolicy as Room };
