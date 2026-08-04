import { LocalApplication } from "./local_app.ts";

const maxJsonBytes = 9 * 1024 * 1024;
const maxSyncBytes = 16 * 1024 * 1024;

function unauthorized(): Response {
  return new Response("unauthorized\n", { status: 401 });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorized(request: Request, token: string): boolean {
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (supplied.length !== token.length) return false;
  let difference = 0;
  for (let index = 0; index < token.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ token.charCodeAt(index);
  }
  return difference === 0;
}

async function readJson<T>(request: Request): Promise<T> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxJsonBytes) throw new Error("request is too large");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "request failed";
  return new Response(`${message}\n`, { status: 400 });
}

export interface LocalHandlerOptions {
  app: LocalApplication;
  token: string;
  uiDirectory?: string | URL;
}

export function createLocalHandler(
  options: LocalHandlerOptions,
): (request: Request) => Promise<Response> {
  const uiDirectory = options.uiDirectory ??
    new URL("../../ui/dist/", import.meta.url);
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        return request.method === "GET"
          ? new Response("ok\n")
          : new Response("method not allowed\n", { status: 405 });
      }
      if (url.pathname === "/api/events") {
        if (url.searchParams.get("token") !== options.token) {
          return unauthorized();
        }
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("websocket upgrade required\n", { status: 426 });
        }
        const { socket, response } = Deno.upgradeWebSocket(request);
        socket.addEventListener(
          "open",
          () => options.app.attachEvents(socket),
          { once: true },
        );
        return response;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(request, options.token)) return unauthorized();
        if (url.pathname === "/api/bootstrap" && request.method === "GET") {
          return json(options.app.bootstrap());
        }
        if (url.pathname === "/api/open" && request.method === "POST") {
          const body = await readJson<{ path: string }>(request);
          return json(await options.app.open(body.path));
        }
        if (url.pathname === "/api/save" && request.method === "POST") {
          const body = await readJson<
            { path: string | null; markdown: string }
          >(request);
          return json(await options.app.save(body.path, body.markdown));
        }
        if (url.pathname === "/api/name" && request.method === "POST") {
          const body = await readJson<{ name: string }>(request);
          await options.app.rename(body.name);
          return json({ ok: true });
        }
        if (url.pathname === "/api/retry" && request.method === "POST") {
          options.app.retryConnection();
          return json({ ok: true });
        }
        if (url.pathname === "/api/sync" && request.method === "POST") {
          const message = new Uint8Array(await request.arrayBuffer());
          if (message.length > maxSyncBytes) {
            return new Response("sync message is too large\n", { status: 413 });
          }
          const filename = request.headers.get("x-editing-filename") ?? "";
          const response = options.app.receiveUiSync(filename, message);
          return response
            ? new Response(new Uint8Array(response).buffer, {
              headers: {
                "content-type": "application/octet-stream",
                "cache-control": "no-store",
              },
            })
            : new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/peer" && request.method === "POST") {
          const body = await readJson<{ id: string }>(request);
          return json(await options.app.selectPeer(body.id));
        }
        return new Response("not found\n", { status: 404 });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed\n", { status: 405 });
      }
      if (
        (url.pathname === "/" || url.pathname === "/index.html") &&
        url.searchParams.get("token") !== options.token
      ) return unauthorized();
      const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const contentType = asset === "index.html"
        ? "text/html; charset=utf-8"
        : asset === "app.js"
        ? "text/javascript; charset=utf-8"
        : asset === "app.css"
        ? "text/css; charset=utf-8"
        : null;
      if (!contentType) return new Response("not found\n", { status: 404 });
      const assetPath = typeof uiDirectory === "string"
        ? `${uiDirectory}/${asset}`
        : new URL(asset, uiDirectory);
      const body = await Deno.readFile(assetPath);
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "content-type": contentType,
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response("not found\n", { status: 404 });
      }
      return errorResponse(error);
    }
  };
}
