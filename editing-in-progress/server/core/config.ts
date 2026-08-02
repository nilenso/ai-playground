import { isUuidV4 } from "./uuid.ts";

export type ConfigErrorCode =
  | "ConfigTooLarge"
  | "InvalidToml"
  | "MissingString"
  | "MissingInteger"
  | "InvalidInstanceId"
  | "InvalidDisplayName"
  | "InvalidSecret"
  | "InvalidSalt"
  | "InvalidIterations"
  | "InvalidRetention";
export class ConfigError extends Error {
  constructor(public readonly code: ConfigErrorCode) {
    super(code);
    this.name = "ConfigError";
  }
}
function fail(code: ConfigErrorCode): never {
  throw new ConfigError(code);
}

type TomlValue = string | number;
function withoutComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted && escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "#" && !quoted) return line.slice(0, i);
  }
  if (quoted || escaped) fail("InvalidToml");
  return line;
}
function parseToml(source: string): Map<string, TomlValue> {
  if (source.length > 0x7fffffff) fail("ConfigTooLarge");
  const result = new Map<string, TomlValue>();
  let table = "";
  for (const raw of source.replaceAll("\r\n", "\n").split("\n")) {
    const line = withoutComment(raw).trim();
    if (!line) continue;
    const tableMatch = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]$/.exec(line);
    if (tableMatch) {
      table = tableMatch[1];
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) fail("InvalidToml");
    const path = table ? `${table}.${assignment[1]}` : assignment[1];
    if (result.has(path)) fail("InvalidToml");
    const rawValue = assignment[2].trim();
    let value: TomlValue;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"')) fail("InvalidToml");
      try {
        value = JSON.parse(rawValue);
      } catch {
        fail("InvalidToml");
      }
      if (typeof value !== "string") fail("InvalidToml");
    } else if (/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(rawValue)) {
      value = Number(rawValue.replaceAll("_", ""));
      if (!Number.isSafeInteger(value)) fail("InvalidToml");
    } else fail("InvalidToml");
    result.set(path, value);
  }
  return result;
}
function stringAt(values: Map<string, TomlValue>, path: string): string {
  const value = values.get(path);
  if (typeof value !== "string") fail("MissingString");
  return value;
}
function integerAt(values: Map<string, TomlValue>, path: string): number {
  const value = values.get(path);
  if (typeof value !== "number") fail("MissingInteger");
  return value;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail("InvalidSecret");
  let result: Uint8Array;
  try {
    result = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (char) => char.charCodeAt(0),
    );
  } catch {
    fail("InvalidSecret");
  }
  const canonical = bytesToBase64(result).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
  if (result.length !== 32 || canonical !== value) fail("InvalidSecret");
  return result;
}
function decodeSalt(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) fail("InvalidSalt");
  let result: Uint8Array;
  try {
    result = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    fail("InvalidSalt");
  }
  if (result.length !== 16 || bytesToBase64(result) !== value) {
    fail("InvalidSalt");
  }
  return result;
}

export interface Config {
  instanceId: string;
  displayName: string;
  coordinatorUrl: string;
  listenAddress: string;
  secret: Uint8Array;
  scramSalt: Uint8Array;
  scramIterations: number;
  offlineRetentionMs: number;
}
export function parseConfig(source: string): Config {
  const values = parseToml(source);
  const instanceId = stringAt(values, "instance.id");
  if (!isUuidV4(instanceId)) fail("InvalidInstanceId");
  const displayName = stringAt(values, "instance.display_name");
  const displayBytes = new TextEncoder().encode(displayName).length;
  if (displayBytes === 0 || displayBytes > 80) fail("InvalidDisplayName");
  const coordinatorUrl = stringAt(values, "coordinator.url");
  const listenAddress = stringAt(values, "coordinator.listen");
  const secret = decodeSecret(stringAt(values, "coordinator.secret_base64"));
  const scramSalt = decodeSalt(
    stringAt(values, "coordinator.scram_salt_base64"),
  );
  const scramIterations = integerAt(values, "coordinator.scram_iterations");
  if (scramIterations < 4096 || scramIterations > 1_000_000) {
    fail("InvalidIterations");
  }
  const retention = integerAt(values, "coordinator.offline_retention_seconds");
  if (retention !== 1800) fail("InvalidRetention");
  return {
    instanceId,
    displayName,
    coordinatorUrl,
    listenAddress,
    secret,
    scramSalt,
    scramIterations,
    offlineRetentionMs: retention * 1000,
  };
}
