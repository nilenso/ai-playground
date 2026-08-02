export const MAGIC = 0x43454431;
export const VERSION = 1;
export const HEADER_SIZE = 16;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const MAX_PAYLOAD_SIZE = MAX_FRAME_SIZE - HEADER_SIZE;

export enum MessageType {
  server_hello = 0x01,
  auth_client_first,
  auth_server_first,
  auth_client_final,
  auth_server_final,
  auth_confirm,
  auth_error,
  ready,
  list_online = 0x10,
  online_list,
  peer_online,
  peer_offline,
  select_view,
  view_selected,
  view_denied,
  release_view,
  owner_offline,
  view_expired,
  owner_state = 0x20,
  owner_update,
  submit_ops,
  ops_applied,
  op_ack,
  op_error,
}

export type ProtocolErrorCode =
  | "BufferTooSmall"
  | "FrameTooShort"
  | "FrameTooLarge"
  | "WrongMagic"
  | "UnsupportedVersion"
  | "NonZeroFlags"
  | "UnknownMessageType"
  | "LengthMismatch"
  | "TrailingData"
  | "UnexpectedEnd"
  | "IntegerOverflow"
  | "InvalidUtf8";

export class ProtocolError extends Error {
  constructor(public readonly code: ProtocolErrorCode) {
    super(code);
    this.name = "ProtocolError";
  }
}

function fail(code: ProtocolErrorCode): never {
  throw new ProtocolError(code);
}
function uint(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail("IntegerOverflow");
  }
  return value;
}
function isMessageType(value: number): value is MessageType {
  return (value >= 0x01 && value <= 0x08) || (value >= 0x10 && value <= 0x19) ||
    (value >= 0x20 && value <= 0x25);
}

export interface Frame {
  messageType: MessageType;
  requestId: number;
  payload: Uint8Array;
}

export function encodeFrame(
  messageType: MessageType,
  requestId: number,
  payload: Uint8Array,
): Uint8Array {
  if (!isMessageType(messageType)) fail("UnknownMessageType");
  uint(requestId, 0xffffffff);
  if (payload.length > MAX_PAYLOAD_SIZE) fail("FrameTooLarge");
  const result = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, MAGIC);
  result[4] = VERSION;
  result[5] = messageType;
  view.setUint16(6, 0);
  view.setUint32(8, requestId);
  view.setUint32(12, payload.length);
  result.set(payload, HEADER_SIZE);
  return result;
}

export function decodeFrame(message: Uint8Array): Frame {
  if (message.length > MAX_FRAME_SIZE) fail("FrameTooLarge");
  if (message.length < HEADER_SIZE) fail("FrameTooShort");
  const view = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
  if (view.getUint32(0) !== MAGIC) fail("WrongMagic");
  if (message[4] !== VERSION) fail("UnsupportedVersion");
  if (!isMessageType(message[5])) fail("UnknownMessageType");
  if (view.getUint16(6) !== 0) fail("NonZeroFlags");
  const payloadLength = view.getUint32(12);
  if (payloadLength > MAX_PAYLOAD_SIZE) fail("FrameTooLarge");
  const expected = HEADER_SIZE + payloadLength;
  if (message.length < expected) fail("LengthMismatch");
  if (message.length > expected) fail("TrailingData");
  return {
    messageType: message[5],
    requestId: view.getUint32(8),
    payload: message.subarray(HEADER_SIZE),
  };
}

export class PayloadWriter {
  readonly #buffer: Uint8Array;
  #position = 0;
  constructor(capacity: number | Uint8Array) {
    this.#buffer = typeof capacity === "number"
      ? new Uint8Array(uint(capacity, MAX_PAYLOAD_SIZE))
      : capacity;
  }
  bytes(): Uint8Array {
    return this.#buffer.subarray(0, this.#position);
  }
  #reserve(count: number): Uint8Array {
    if (count > this.#buffer.length - this.#position) fail("BufferTooSmall");
    const start = this.#position;
    this.#position += count;
    return this.#buffer.subarray(start, this.#position);
  }
  writeU8(value: number): this {
    this.#reserve(1)[0] = uint(value, 0xff);
    return this;
  }
  writeU16(value: number): this {
    new DataView(
      this.#reserve(2).buffer,
      this.#buffer.byteOffset + this.#position - 2,
      2,
    ).setUint16(0, uint(value, 0xffff));
    return this;
  }
  writeU32(value: number): this {
    new DataView(
      this.#reserve(4).buffer,
      this.#buffer.byteOffset + this.#position - 4,
      4,
    ).setUint32(0, uint(value, 0xffffffff));
    return this;
  }
  writeU64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) fail("IntegerOverflow");
    const out = this.#reserve(8);
    new DataView(out.buffer, out.byteOffset, 8).setBigUint64(0, value);
    return this;
  }
  writeUuid(value: Uint8Array): this {
    if (value.length !== 16) fail("IntegerOverflow");
    this.#reserve(16).set(value);
    return this;
  }
  writeString(value: string): this {
    const encoded = new TextEncoder().encode(value);
    if (encoded.length > 0xffff) fail("IntegerOverflow");
    this.writeU16(encoded.length);
    this.#reserve(encoded.length).set(encoded);
    return this;
  }
  writeBlob(value: Uint8Array): this {
    if (value.length > MAX_PAYLOAD_SIZE) fail("IntegerOverflow");
    this.writeU32(value.length);
    this.#reserve(value.length).set(value);
    return this;
  }
}

export class PayloadCursor {
  #position = 0;
  constructor(private readonly payload: Uint8Array) {}
  remaining(): number {
    return this.payload.length - this.#position;
  }
  #take(count: number): Uint8Array {
    if (count > this.remaining()) fail("UnexpectedEnd");
    const start = this.#position;
    this.#position += count;
    return this.payload.subarray(start, this.#position);
  }
  finish(): void {
    if (this.#position !== this.payload.length) fail("TrailingData");
  }
  readU8(): number {
    return this.#take(1)[0];
  }
  readU16(): number {
    const value = this.#take(2);
    return new DataView(value.buffer, value.byteOffset, 2).getUint16(0);
  }
  readU32(): number {
    const value = this.#take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0);
  }
  readU64(): bigint {
    const value = this.#take(8);
    return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0);
  }
  readUuid(): Uint8Array {
    return this.#take(16);
  }
  readString(): string {
    const value = this.#take(this.readU16());
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      fail("InvalidUtf8");
    }
  }
  readBlob(): Uint8Array {
    const length = this.readU32();
    if (length > MAX_PAYLOAD_SIZE) fail("IntegerOverflow");
    return this.#take(length);
  }
}
