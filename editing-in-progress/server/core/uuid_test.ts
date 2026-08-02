import { formatUuid, generateUuidV4, parseUuidV4 } from "./uuid.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function equalBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert(actual.length === expected.length, "length mismatch");
  for (let i = 0; i < actual.length; i++) {
    assert(actual[i] === expected[i], `byte ${i} mismatch`);
  }
}
function throws(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected function to throw");
}

Deno.test("UUIDv4 formats and parses canonical lowercase text", () => {
  const bytes = Uint8Array.from([
    0xa0,
    0x27,
    0x8d,
    0x03,
    0x0c,
    0x01,
    0x47,
    0x3d,
    0xb8,
    0xe4,
    0xa6,
    0x2e,
    0x2e,
    0x3b,
    0x31,
    0x83,
  ]);
  const text = formatUuid(bytes);
  assert(text === "a0278d03-0c01-473d-b8e4-a62e2e3b3183");
  equalBytes(parseUuidV4(text), bytes);
});

Deno.test("UUIDv4 parser rejects noncanonical, non-v4, and wrong-variant values", () => {
  throws(() => parseUuidV4("A0278d03-0c01-473d-b8e4-a62e2e3b3183"));
  throws(() => parseUuidV4("a0278d030c01-473d-b8e4-a62e2e3b3183"));
  throws(() => parseUuidV4("a0278d03-0c01-573d-b8e4-a62e2e3b3183"));
  throws(() => parseUuidV4("a0278d03-0c01-473d-78e4-a62e2e3b3183"));
});

Deno.test("generated UUID has RFC 4122 version and variant bits", () => {
  const bytes = generateUuidV4();
  assert(bytes.length === 16);
  assert(bytes[6] >>> 4 === 4);
  assert(bytes[8] >>> 6 === 2);
  equalBytes(parseUuidV4(formatUuid(bytes)), bytes);
});
