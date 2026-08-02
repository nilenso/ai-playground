import {
  decodeFrame,
  encodeFrame,
  HEADER_SIZE,
  MAX_FRAME_SIZE,
  MessageType,
  PayloadCursor,
  PayloadWriter,
  ProtocolError,
} from "./protocol.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function equalBytes(a: Uint8Array, b: Uint8Array): void {
  assert(a.length === b.length);
  for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `byte ${i}`);
}
function errorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof ProtocolError);
    assert(error.code === code, `${error.code} !== ${code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("CED1 frame roundtrip preserves network-order header and payload", () => {
  const encoded = encodeFrame(
    MessageType.owner_update,
    0x01020304,
    new TextEncoder().encode("payload"),
  );
  equalBytes(encoded.subarray(0, 4), Uint8Array.of(0x43, 0x45, 0x44, 0x31));
  assert(encoded.length === HEADER_SIZE + 7);
  const frame = decodeFrame(encoded);
  assert(frame.messageType === MessageType.owner_update);
  assert(frame.requestId === 0x01020304);
  assert(new TextDecoder().decode(frame.payload) === "payload");
});

Deno.test("CED1 decoder strictly rejects malformed headers and lengths", () => {
  const valid = encodeFrame(MessageType.ready, 7, new Uint8Array());
  const mutate = (index: number, value: number) => {
    const copy = valid.slice();
    copy[index] = value;
    return copy;
  };
  errorCode(() => decodeFrame(valid.subarray(0, 15)), "FrameTooShort");
  errorCode(() => decodeFrame(mutate(0, 0)), "WrongMagic");
  errorCode(() => decodeFrame(mutate(4, 2)), "UnsupportedVersion");
  errorCode(() => decodeFrame(mutate(5, 9)), "UnknownMessageType");
  errorCode(() => decodeFrame(mutate(7, 1)), "NonZeroFlags");
  const missing = valid.slice();
  new DataView(missing.buffer).setUint32(12, 1);
  errorCode(() => decodeFrame(missing), "LengthMismatch");
  errorCode(() => decodeFrame(new Uint8Array([...valid, 0])), "TrailingData");
  errorCode(
    () => decodeFrame(new Uint8Array(MAX_FRAME_SIZE + 1)),
    "FrameTooLarge",
  );
});

Deno.test("payload writer and cursor roundtrip strict bounded values", () => {
  const uuid = Uint8Array.from({ length: 16 }, (_, i) => i);
  const writer = new PayloadWriter(128);
  writer.writeU8(9).writeU16(0x102).writeU32(0x01020304).writeU64(
    0x0102030405060708n,
  )
    .writeUuid(uuid).writeString("héllo").writeBlob(Uint8Array.of(0, 255, 1));
  const cursor = new PayloadCursor(writer.bytes());
  assert(cursor.readU8() === 9);
  assert(cursor.readU16() === 0x102);
  assert(cursor.readU32() === 0x01020304);
  assert(cursor.readU64() === 0x0102030405060708n);
  equalBytes(cursor.readUuid(), uuid);
  assert(cursor.readString() === "héllo");
  equalBytes(cursor.readBlob(), Uint8Array.of(0, 255, 1));
  cursor.finish();
});

Deno.test("payload cursors reject truncation, invalid UTF-8, overflow, and trailing data", () => {
  errorCode(
    () => new PayloadCursor(new Uint8Array(15)).readUuid(),
    "UnexpectedEnd",
  );
  errorCode(
    () => new PayloadCursor(Uint8Array.of(0, 3, 97, 98)).readString(),
    "UnexpectedEnd",
  );
  errorCode(
    () => new PayloadCursor(Uint8Array.of(0, 1, 0xff)).readString(),
    "InvalidUtf8",
  );
  errorCode(
    () => new PayloadCursor(Uint8Array.of(0, 0, 0, 2, 1)).readBlob(),
    "UnexpectedEnd",
  );
  const cursor = new PayloadCursor(Uint8Array.of(1, 2));
  cursor.readU8();
  errorCode(() => cursor.finish(), "TrailingData");
  errorCode(() => new PayloadWriter(1).writeU16(1), "BufferTooSmall");
  errorCode(() => new PayloadWriter(10).writeU8(256), "IntegerOverflow");
});
