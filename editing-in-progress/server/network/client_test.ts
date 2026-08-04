import { reconnectDelayMs } from "./client.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("coordinator reconnect delay backs off exponentially to ten minutes", () => {
  assertEquals(reconnectDelayMs(0), 250);
  assertEquals(reconnectDelayMs(1), 500);
  assertEquals(reconnectDelayMs(11), 512_000);
  assertEquals(reconnectDelayMs(12), 600_000);
  assertEquals(reconnectDelayMs(100), 600_000);
});
