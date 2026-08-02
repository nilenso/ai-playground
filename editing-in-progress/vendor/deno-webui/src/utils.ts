/* Vendored from webui-dev/deno-webui 2.5.15 under the MIT license. */

export function toCString(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${value}\0`);
}

export function fromCString(value: Uint8Array): string {
  const terminator = value.findIndex((byte) => byte === 0);
  return new TextDecoder().decode(
    terminator < 0 ? value : value.slice(0, terminator),
  );
}

export class WebUIError extends Error {}
