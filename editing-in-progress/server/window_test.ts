import { isLocalWindowUrl } from "./window.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("native window accepts only a tokenized IPv4 loopback URL", () => {
  assert(
    isLocalWindowUrl(
      "http://127.0.0.1:41827/?token=abcdefghijklmnopqrstuvwxyz0123456789_-",
    ),
    "valid URL rejected",
  );
  for (
    const invalid of [
      "https://127.0.0.1:41827/?token=abcdefghijklmnopqrstuvwxyz0123456789",
      "http://localhost:41827/?token=abcdefghijklmnopqrstuvwxyz0123456789",
      "http://127.0.0.1:41827/other?token=abcdefghijklmnopqrstuvwxyz0123456789",
      "http://127.0.0.1:41827/?token=short",
      "http://127.0.0.1:41827/?token=abcdefghijklmnopqrstuvwxyz0123456789&extra=1",
      "http://example.com:41827/?token=abcdefghijklmnopqrstuvwxyz0123456789",
    ]
  ) assert(!isLocalWindowUrl(invalid), `accepted ${invalid}`);
});
