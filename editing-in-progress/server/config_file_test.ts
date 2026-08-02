import { loadOrCreateConfig, parseListenAddress } from "./config_file.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("first run creates private valid config with a stable UUID", async () => {
  const home = await Deno.makeTempDir();
  try {
    const first = await loadOrCreateConfig(home);
    const second = await loadOrCreateConfig(home);
    assertEquals(first.created, true);
    assertEquals(second.created, false);
    assertEquals(first.config.instanceId, second.config.instanceId);
    assertEquals(first.config.secret.length, 32);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(first.path)).mode! & 0o777;
      assertEquals(mode, 0o600);
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("listen address parser rejects invalid ports", () => {
  assertEquals(parseListenAddress("127.0.0.1:8787").port, 8787);
  for (const value of ["127.0.0.1", "127.0.0.1:0", "127.0.0.1:99999"]) {
    let failed = false;
    try {
      parseListenAddress(value);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error(`accepted ${value}`);
  }
});
