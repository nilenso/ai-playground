import { type Config, parseConfig } from "./core/config.ts";
import { configPath } from "./state/storage.ts";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
function escapeToml(value: string): string {
  return JSON.stringify(value);
}
function defaultConfig(): string {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const displayName = Deno.env.get("USER")?.trim() || "Writer";
  return `[instance]\nid = ${escapeToml(crypto.randomUUID())}\ndisplay_name = ${
    escapeToml(displayName)
  }\n\n[coordinator]\nurl = "ws://127.0.0.1:8787/v1"\nlisten = "127.0.0.1:8787"\nsecret_base64 = "${
    base64Url(secret)
  }"\nscram_salt_base64 = "${
    base64(salt)
  }"\nscram_iterations = 32768\noffline_retention_seconds = 1800\n`;
}

export async function loadOrCreateConfig(
  home: string,
): Promise<{ config: Config; path: string; created: boolean }> {
  const path = configPath(home);
  let source: string;
  let created = false;
  try {
    source = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    source = defaultConfig();
    const slash = path.lastIndexOf("/");
    await Deno.mkdir(path.slice(0, slash), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(temporary, source, {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temporary, path);
    created = true;
  }
  return { config: parseConfig(source), path, created };
}

export function parseListenAddress(
  value: string,
): { hostname: string; port: number } {
  const match = /^(\[[0-9a-fA-F:]+\]|[^:]+):([0-9]{1,5})$/.exec(value);
  if (!match) throw new Error("invalid coordinator.listen address");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) {
    throw new Error("invalid coordinator.listen port");
  }
  const hostname = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  return { hostname, port };
}
