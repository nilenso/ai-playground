const CANONICAL_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateUuidV4(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

export function formatUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new TypeError("UUID must contain exactly 16 bytes");
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function parseUuidV4(value: string): Uint8Array {
  if (!CANONICAL_V4.test(value)) {
    throw new TypeError("invalid canonical UUIDv4");
  }
  const hex = value.replaceAll("-", "");
  const result = new Uint8Array(16);
  for (let i = 0; i < result.length; i++) {
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

export function isUuidV4(value: string): boolean {
  return CANONICAL_V4.test(value);
}
