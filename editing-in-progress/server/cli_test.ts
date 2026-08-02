import { parseMode } from "./cli.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("Deno CLI accepts serve, edit, and edit --serve only", () => {
  assertEquals(parseMode(["serve"]), "serve");
  assertEquals(parseMode(["edit"]), "edit");
  assertEquals(parseMode(["edit", "--serve"]), "edit-and-serve");
  for (
    const invalid of [[], ["edit", "--other"], ["serve", "--extra"], [
      "unknown",
    ]]
  ) {
    let failed = false;
    try {
      parseMode(invalid);
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(`accepted invalid arguments: ${invalid.join(" ")}`);
    }
  }
});
