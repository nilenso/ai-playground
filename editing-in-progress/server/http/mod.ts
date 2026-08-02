const COLLAB_PROTOCOL = "collab.v1";
const DEFAULT_STATIC_LIMIT = 8 * 1024 * 1024;
const DEFAULT_WEBSOCKET_MESSAGE_LIMIT = 1024 * 1024;
const DEFAULT_STATIC_ROOT = new URL("../../ui/dist/", import.meta.url);

export interface CollabSession {
  readonly request: Request;
  readonly protocol: typeof COLLAB_PROTOCOL;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface CollabSessionHandler {
  onConnect(session: CollabSession): void | Promise<void>;
  onMessage?(
    session: CollabSession,
    message: string | Uint8Array,
  ): void | Promise<void>;
  onClose?(session: CollabSession, event: CloseEvent): void | Promise<void>;
  onError?(session: CollabSession, event: Event): void | Promise<void>;
}

export interface HttpHandlerOptions {
  /** Directory containing the deterministic index.html, app.js, and app.css build outputs. */
  staticRoot?: string | URL;
  sessions: CollabSessionHandler;
  maxStaticBytes?: number;
  maxWebSocketMessageBytes?: number;
}

export interface ServeHttpOptions extends HttpHandlerOptions {
  /** Defaults to loopback; callers must opt in to network exposure. */
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
  onListen?: (params: { hostname: string; port: number }) => void;
}

type UiAsset = {
  file: "index.html" | "app.js" | "app.css";
  contentType: string;
};

const UI_ASSETS: Readonly<Record<string, UiAsset>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": {
    file: "index.html",
    contentType: "text/html; charset=utf-8",
  },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
};

const textEncoder = new TextEncoder();

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function responseHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
}

function errorResponse(
  status: number,
  message: string,
  extra?: HeadersInit,
): Response {
  const headers = responseHeaders("text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  if (extra) {
    for (const [name, value] of new Headers(extra)) headers.set(name, value);
  }
  return new Response(`${message}\n`, { status, headers });
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(405, "method not allowed", { allow });
}

function rootPath(root: string | URL, file: UiAsset["file"]): string | URL {
  if (root instanceof URL) {
    return new URL(file, root.href.endsWith("/") ? root : `${root.href}/`);
  }
  return `${root.replace(/[\\/]$/, "")}/${file}`;
}

async function serveAsset(
  request: Request,
  root: string | URL,
  asset: UiAsset,
  maxBytes: number,
): Promise<Response> {
  const path = rootPath(root, asset.file);
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return errorResponse(404, "not found");
    if (info.size > maxBytes) return errorResponse(413, "asset too large");

    const headers = responseHeaders(asset.contentType);
    headers.set("content-length", String(info.size));
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const bytes = await Deno.readFile(path);
    if (bytes.byteLength > maxBytes) {
      return errorResponse(413, "asset too large");
    }
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return errorResponse(404, "not found");
    }
    throw error;
  }
}

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function messageSize(data: string | ArrayBuffer): number {
  return typeof data === "string"
    ? textEncoder.encode(data).byteLength
    : data.byteLength;
}

function reportFailure(socket: WebSocket, error: unknown): void {
  console.error("collab websocket session handler failed", error);
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close(1011, "session handler failed");
  }
}

function invoke(
  socket: WebSocket,
  callback: (() => void | Promise<void>) | undefined,
): void {
  if (!callback) return;
  try {
    Promise.resolve(callback()).catch((error) => reportFailure(socket, error));
  } catch (error) {
    reportFailure(socket, error);
  }
}

function upgrade(
  request: Request,
  sessions: CollabSessionHandler,
  maxMessageBytes: number,
): Response {
  if (!isWebSocketUpgrade(request)) {
    return errorResponse(426, "websocket upgrade required", {
      upgrade: "websocket",
    });
  }
  if (!offeredProtocols(request).includes(COLLAB_PROTOCOL)) {
    return errorResponse(
      400,
      `${COLLAB_PROTOCOL} websocket subprotocol required`,
    );
  }

  let upgraded: { socket: WebSocket; response: Response };
  try {
    upgraded = Deno.upgradeWebSocket(request, { protocol: COLLAB_PROTOCOL });
  } catch {
    return errorResponse(400, "invalid websocket upgrade");
  }

  const { socket } = upgraded;
  const session: CollabSession = {
    request,
    protocol: COLLAB_PROTOCOL,
    send: (data) => {
      if (typeof data === "string") {
        socket.send(data);
      } else if (ArrayBuffer.isView(data)) {
        socket.send(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            .buffer,
        );
      } else {
        socket.send(new Uint8Array(data).slice().buffer);
      }
    },
    close: (code, reason) => socket.close(code, reason),
  };

  socket.addEventListener("open", () => {
    invoke(socket, () => sessions.onConnect(session));
  });
  socket.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (messageSize(event.data) > maxMessageBytes) {
        socket.close(1009, "message too large");
        return;
      }
      const message = typeof event.data === "string"
        ? event.data
        : new Uint8Array(event.data);
      invoke(
        socket,
        sessions.onMessage
          ? () => sessions.onMessage!(session, message)
          : undefined,
      );
    },
  );
  socket.addEventListener("close", (event) => {
    invoke(
      socket,
      sessions.onClose ? () => sessions.onClose!(session, event) : undefined,
    );
  });
  socket.addEventListener("error", (event) => {
    invoke(
      socket,
      sessions.onError ? () => sessions.onError!(session, event) : undefined,
    );
  });

  return upgraded.response;
}

export type HttpHandler = (request: Request) => Response | Promise<Response>;

/** Creates a dependency-light router suitable for Deno.serve and direct unit testing. */
export function createHttpHandler(options: HttpHandlerOptions): HttpHandler {
  const root = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const maxStaticBytes = boundedInteger(
    options.maxStaticBytes,
    DEFAULT_STATIC_LIMIT,
    "maxStaticBytes",
  );
  const maxMessageBytes = boundedInteger(
    options.maxWebSocketMessageBytes,
    DEFAULT_WEBSOCKET_MESSAGE_LIMIT,
    "maxWebSocketMessageBytes",
  );

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      const headers = responseHeaders("text/plain; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(request.method === "HEAD" ? null : "ok\n", {
        headers,
      });
    }

    if (pathname === "/v1") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return upgrade(request, options.sessions, maxMessageBytes);
    }

    const asset = UI_ASSETS[pathname];
    if (!asset) return errorResponse(404, "not found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return await serveAsset(request, root, asset, maxStaticBytes);
  };
}

/** Starts on 127.0.0.1 by default. Pass a hostname explicitly to expose it. */
export function serveHttp(options: ServeHttpOptions): Deno.HttpServer {
  const { hostname = "127.0.0.1", port = 8000, signal, onListen } = options;
  return Deno.serve(
    { hostname, port, signal, onListen },
    createHttpHandler(options),
  );
}
