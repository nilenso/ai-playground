export const APPLICATION_DIR = "editing-in-progress";
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const RECOVERY_HEADER_BYTES = 68;
export const MAX_RECOVERY_FILE_BYTES = RECOVERY_HEADER_BYTES +
  MAX_SNAPSHOT_BYTES;
export const MAX_MRU_ENTRIES = 16;
export const MAX_LOCAL_PATH_BYTES = 4096;
export const MAX_MRU_FILE_BYTES = 12 +
  MAX_MRU_ENTRIES * (2 + MAX_LOCAL_PATH_BYTES);

const RECOVERY_MAGIC = new Uint8Array([69, 73, 80, 82, 67, 86, 49, 0]); // EIPRCV1\0
const MRU_MAGIC = new Uint8Array([69, 73, 80, 77, 82, 85, 49, 0]); // EIPMRU1\0
const VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const RECOVERY_FIELDS = new Set([
  "instanceUuid",
  "roomUuid",
  "serverEpoch",
  "snapshot",
  "dirty",
  "unsynced",
  "updatedTimestamp",
]);

export type StateValidationErrorCode =
  | "FILE_TOO_LARGE"
  | "INVALID_ENCODING"
  | "INVALID_MAGIC"
  | "INVALID_PATH"
  | "INVALID_TIMESTAMP"
  | "INVALID_UUID"
  | "NOT_LOCAL_OWNER"
  | "REMOTE_DOCUMENT"
  | "SNAPSHOT_TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "TRAILING_DATA"
  | "TRUNCATED"
  | "UNEXPECTED_FIELD"
  | "UNSUPPORTED_VERSION";

export class StateValidationError extends Error {
  constructor(readonly code: StateValidationErrorCode, message: string = code) {
    super(message);
    this.name = "StateValidationError";
  }
}

function fail(code: StateValidationErrorCode, message?: string): never {
  throw new StateValidationError(code, message);
}

export interface RecoveryV1 {
  instanceUuid: string;
  roomUuid: string;
  serverEpoch: bigint | null;
  snapshot: Uint8Array;
  dirty: boolean;
  unsynced: boolean;
  updatedTimestamp: number;
}

export function configPath(home: string): string {
  return joinHome(home, [".config", APPLICATION_DIR, "config.toml"]);
}

export function statePath(home: string): string {
  return joinHome(home, [".local", "share", APPLICATION_DIR]);
}

function joinHome(home: string, components: readonly string[]): string {
  if (typeof home !== "string" || home.includes("\0")) fail("INVALID_PATH");
  const windows = Deno.build.os === "windows";
  const absolute = windows
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(home)
    : home.startsWith("/");
  if (!absolute) fail("INVALID_PATH", "home must be absolute");
  const separator = windows ? "\\" : "/";
  const trimmed = home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
  if (trimmed === separator) return separator + components.join(separator);
  return [trimmed, ...components].join(separator);
}

/**
 * Validates both format and privacy boundaries. Exact-field validation prevents
 * secrets, remote documents, presence, paths, and authentication data from
 * finding an accidental persistence channel.
 */
export function validateRecovery(
  value: RecoveryV1,
  localInstanceUuid?: string,
): void {
  if (
    value === null || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("INVALID_ENCODING", "recovery must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (!RECOVERY_FIELDS.has(key)) {
      fail("UNEXPECTED_FIELD", `recovery field ${key} is forbidden`);
    }
  }
  for (const field of RECOVERY_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      fail("INVALID_ENCODING", `missing recovery field ${field}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) {
      fail("INVALID_ENCODING", `accessor field ${field} is forbidden`);
    }
  }
  if (!validUuid(value.instanceUuid) || !validUuid(value.roomUuid)) {
    fail("INVALID_UUID");
  }
  if (localInstanceUuid !== undefined) {
    if (!validUuid(localInstanceUuid)) fail("INVALID_UUID");
    if (value.instanceUuid !== localInstanceUuid) fail("NOT_LOCAL_OWNER");
  }
  if (
    value.serverEpoch !== null &&
    (typeof value.serverEpoch !== "bigint" || value.serverEpoch < 0n ||
      value.serverEpoch > 0xffff_ffff_ffff_ffffn)
  ) {
    fail(
      "INVALID_ENCODING",
      "server epoch must be an unsigned 64-bit integer or null",
    );
  }
  if (!(value.snapshot instanceof Uint8Array)) {
    fail("INVALID_ENCODING", "snapshot must be bytes");
  }
  if (value.snapshot.byteLength > MAX_SNAPSHOT_BYTES) {
    fail("SNAPSHOT_TOO_LARGE");
  }
  if (typeof value.dirty !== "boolean" || typeof value.unsynced !== "boolean") {
    fail("INVALID_ENCODING");
  }
  if (
    !Number.isSafeInteger(value.updatedTimestamp) || value.updatedTimestamp < 0
  ) fail("INVALID_TIMESTAMP");
}

export function encodeRecovery(
  value: RecoveryV1,
  localInstanceUuid?: string,
): Uint8Array {
  validateRecovery(value, localInstanceUuid);
  const output = new Uint8Array(
    RECOVERY_HEADER_BYTES + value.snapshot.byteLength,
  );
  output.set(RECOVERY_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(8, VERSION, true);
  output[10] = Number(value.dirty) | (Number(value.unsynced) << 1) |
    (Number(value.serverEpoch !== null) << 2);
  output.set(uuidToBytes(value.instanceUuid), 12);
  output.set(uuidToBytes(value.roomUuid), 28);
  view.setBigUint64(44, value.serverEpoch ?? 0n, true);
  view.setBigInt64(52, BigInt(value.updatedTimestamp), true);
  view.setBigUint64(60, BigInt(value.snapshot.byteLength), true);
  output.set(value.snapshot, RECOVERY_HEADER_BYTES);
  return output;
}

export function decodeRecovery(input: Uint8Array): RecoveryV1 {
  if (input.byteLength < RECOVERY_HEADER_BYTES) fail("TRUNCATED");
  if (!equalBytes(input.subarray(0, 8), RECOVERY_MAGIC)) fail("INVALID_MAGIC");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint16(8, true) !== VERSION) fail("UNSUPPORTED_VERSION");
  const flags = input[10];
  if ((flags & ~0x07) !== 0 || input[11] !== 0) fail("INVALID_ENCODING");
  const rawEpoch = view.getBigUint64(44, true);
  const hasEpoch = (flags & 0x04) !== 0;
  if (!hasEpoch && rawEpoch !== 0n) fail("INVALID_ENCODING");
  const timestamp = view.getBigInt64(52, true);
  if (timestamp < 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("INVALID_TIMESTAMP");
  }
  const snapshotLength = view.getBigUint64(60, true);
  if (snapshotLength > BigInt(MAX_SNAPSHOT_BYTES)) fail("SNAPSHOT_TOO_LARGE");
  const expected = RECOVERY_HEADER_BYTES + Number(snapshotLength);
  if (input.byteLength < expected) fail("TRUNCATED");
  if (input.byteLength > expected) fail("TRAILING_DATA");
  const value: RecoveryV1 = {
    instanceUuid: bytesToUuid(input.subarray(12, 28)),
    roomUuid: bytesToUuid(input.subarray(28, 44)),
    serverEpoch: hasEpoch ? rawEpoch : null,
    snapshot: input.slice(RECOVERY_HEADER_BYTES),
    dirty: (flags & 1) !== 0,
    unsynced: (flags & 2) !== 0,
    updatedTimestamp: Number(timestamp),
  };
  validateRecovery(value);
  return value;
}

export class MruState {
  #entries: string[];

  constructor(entries: readonly string[] = []) {
    if (entries.length > MAX_MRU_ENTRIES) fail("TOO_MANY_ENTRIES");
    const seen = new Set<string>();
    this.#entries = [];
    for (const path of entries) {
      validateLocalMarkdownPath(path);
      if (seen.has(path)) fail("INVALID_ENCODING", "duplicate MRU entry");
      seen.add(path);
      this.#entries.push(path);
    }
  }

  get entries(): readonly string[] {
    return [...this.#entries];
  }

  get count(): number {
    return this.#entries.length;
  }

  get(index: number): string | undefined {
    return this.#entries[index];
  }

  touchLocal(path: string): void {
    validateLocalMarkdownPath(path);
    this.#entries = [
      path,
      ...this.#entries.filter((candidate) => candidate !== path),
    ].slice(0, MAX_MRU_ENTRIES);
  }
}

export function validateLocalMarkdownPath(path: string): void {
  if (typeof path !== "string" || path.includes("\0")) fail("INVALID_PATH");
  if (
    path.includes("://") || path.startsWith("remote:") ||
    path.startsWith("room:")
  ) {
    fail("REMOTE_DOCUMENT");
  }
  const length = new TextEncoder().encode(path).byteLength;
  if (length === 0 || length > MAX_LOCAL_PATH_BYTES) fail("INVALID_PATH");
  const absolute = Deno.build.os === "windows"
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(path)
    : path.startsWith("/");
  if (!absolute || !path.toLowerCase().endsWith(".md") || /[\\/]$/.test(path)) {
    fail("INVALID_PATH");
  }
}

export function encodeMru(mru: MruState): Uint8Array {
  const encoder = new TextEncoder();
  const paths = mru.entries.map((path) => {
    validateLocalMarkdownPath(path);
    return encoder.encode(path);
  });
  let needed = 12;
  for (const path of paths) needed += 2 + path.byteLength;
  const output = new Uint8Array(needed);
  output.set(MRU_MAGIC);
  const view = new DataView(output.buffer);
  view.setUint16(8, VERSION, true);
  view.setUint16(10, paths.length, true);
  let cursor = 12;
  for (const path of paths) {
    view.setUint16(cursor, path.byteLength, true);
    cursor += 2;
    output.set(path, cursor);
    cursor += path.byteLength;
  }
  return output;
}

export function decodeMru(input: Uint8Array): MruState {
  if (input.byteLength < 12) fail("TRUNCATED");
  if (!equalBytes(input.subarray(0, 8), MRU_MAGIC)) fail("INVALID_MAGIC");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint16(8, true) !== VERSION) fail("UNSUPPORTED_VERSION");
  const count = view.getUint16(10, true);
  if (count > MAX_MRU_ENTRIES) fail("TOO_MANY_ENTRIES");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: string[] = [];
  let cursor = 12;
  for (let index = 0; index < count; index++) {
    if (input.byteLength - cursor < 2) fail("TRUNCATED");
    const length = view.getUint16(cursor, true);
    cursor += 2;
    if (length > MAX_LOCAL_PATH_BYTES || input.byteLength - cursor < length) {
      fail("TRUNCATED");
    }
    try {
      entries.push(decoder.decode(input.subarray(cursor, cursor + length)));
    } catch {
      fail("INVALID_ENCODING");
    }
    cursor += length;
  }
  if (cursor !== input.byteLength) fail("TRAILING_DATA");
  return new MruState(entries);
}

export async function writeRecoveryAtomic(
  path: string,
  value: RecoveryV1,
  localInstanceUuid: string,
): Promise<void> {
  await writeAtomic(
    path,
    encodeRecovery(value, localInstanceUuid),
    MAX_RECOVERY_FILE_BYTES,
  );
}

export async function readRecovery(
  path: string,
  localInstanceUuid?: string,
): Promise<RecoveryV1> {
  const value = decodeRecovery(
    await readBounded(path, MAX_RECOVERY_FILE_BYTES),
  );
  validateRecovery(value, localInstanceUuid);
  return value;
}

export async function writeMruAtomic(
  path: string,
  mru: MruState,
): Promise<void> {
  await writeAtomic(path, encodeMru(mru), MAX_MRU_FILE_BYTES);
}

export async function readMru(path: string): Promise<MruState> {
  return decodeMru(await readBounded(path, MAX_MRU_FILE_BYTES));
}

async function readBounded(path: string, maximum: number): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const stat = await file.stat();
    if (!stat.isFile) {
      fail("INVALID_ENCODING", "state path is not a regular file");
    }
    if (stat.size > maximum) fail("FILE_TOO_LARGE");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buffer = new Uint8Array(Math.min(64 * 1024, maximum + 1));
    while (true) {
      const read = await file.read(buffer);
      if (read === null) break;
      total += read;
      if (total > maximum) fail("FILE_TOO_LARGE");
      chunks.push(buffer.slice(0, read));
    }
    const result = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      result.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return result;
  } finally {
    file.close();
  }
}

async function writeAtomic(
  path: string,
  bytes: Uint8Array,
  maximum: number,
): Promise<void> {
  if (bytes.byteLength > maximum) fail("FILE_TOO_LARGE");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = slash < 0 ? "." : path.slice(0, slash) || "/";
  const filename = path.slice(slash + 1);
  if (!filename) fail("INVALID_PATH");
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/${filename}.tmp-${crypto.randomUUID()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
    file.close();
    file = undefined;
    if (Deno.build.os !== "windows") await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    file?.close();
    try {
      await Deno.remove(temporary);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

function validUuid(uuid: unknown): uuid is string {
  return typeof uuid === "string" && uuid !== ZERO_UUID &&
    UUID_PATTERN.test(uuid);
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}
