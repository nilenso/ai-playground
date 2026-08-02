import { ConfigError, parseConfig } from "./config.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function expectCode(source: string, code: string): void {
  try {
    parseConfig(source);
  } catch (error) {
    assert(error instanceof ConfigError);
    assert(error.code === code, `${error.code} !== ${code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}
const valid = `[instance]
id = "d9428888-122b-4fee-9bb0-d7c1651c1f8b"
display_name = "Alice"
[coordinator]
url = "ws://127.0.0.1:8787/room"
listen = "127.0.0.1:8787"
secret_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
scram_salt_base64 = "AAAAAAAAAAAAAAAAAAAAAA=="
scram_iterations = 4096
offline_retention_seconds = 1800
`;

Deno.test("configuration parses complete TOML and decodes cryptographic material", () => {
  const config = parseConfig(valid);
  assert(config.instanceId === "d9428888-122b-4fee-9bb0-d7c1651c1f8b");
  assert(config.displayName === "Alice");
  assert(config.coordinatorUrl === "ws://127.0.0.1:8787/room");
  assert(config.listenAddress === "127.0.0.1:8787");
  assert(
    config.secret.length === 32 && config.secret.every((byte) => byte === 0),
  );
  assert(
    config.scramSalt.length === 16 && config.scramIterations === 4096 &&
      config.offlineRetentionMs === 1_800_000,
  );
});

Deno.test("configuration validates UUID, display name, keys, iterations, and retention", () => {
  expectCode(valid.replace("d9428888", "D9428888"), "InvalidInstanceId");
  expectCode(
    valid.replace('display_name = "Alice"', 'display_name = ""'),
    "InvalidDisplayName",
  );
  expectCode(
    valid.replace("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "dG9vLXdlYWs"),
    "InvalidSecret",
  );
  expectCode(
    valid.replace("AAAAAAAAAAAAAAAAAAAAAA==", "AAAAAAAAAAAAAAAAAAAAAA=A"),
    "InvalidSalt",
  );
  expectCode(
    valid.replace("scram_iterations = 4096", "scram_iterations = 4095"),
    "InvalidIterations",
  );
  expectCode(
    valid.replace("scram_iterations = 4096", "scram_iterations = 1000001"),
    "InvalidIterations",
  );
  expectCode(
    valid.replace(
      "offline_retention_seconds = 1800",
      "offline_retention_seconds = 1799",
    ),
    "InvalidRetention",
  );
});

Deno.test("configuration parser rejects malformed, duplicate, missing, and wrongly typed TOML", () => {
  expectCode('[instance\nid = "x"', "InvalidToml");
  expectCode(
    valid.replace(
      'display_name = "Alice"',
      'display_name = "Alice"\ndisplay_name = "Mallory"',
    ),
    "InvalidToml",
  );
  expectCode(
    valid.replace('url = "ws://127.0.0.1:8787/room"\n', ""),
    "MissingString",
  );
  expectCode(
    valid.replace("scram_iterations = 4096", 'scram_iterations = "4096"'),
    "MissingInteger",
  );
});
