import { basename, type ConnectionStatus, type PeerPresence } from "./state.ts";

export interface BootstrapState {
  instanceId: string;
  name: string;
  filename: string;
  path: string | null;
  markdown: string;
  snapshotBase64?: string;
  recentFiles: string[];
  status: ConnectionStatus;
  peers: PeerPresence[];
}

export type UiEvent =
  | { type: "state"; state: BootstrapState }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "presence"; peers: PeerPresence[] }
  | { type: "view-expired"; ownerId: string }
  | {
    type: "remote-state";
    ownerId: string;
    name: string;
    filename: string;
    markdown: string;
  }
  | {
    type: "sync";
    filename: string;
    message: Uint8Array | ArrayBuffer | number[];
  };

type NativeBytes = Uint8Array | ArrayBuffer | number[];
let dispatchHandler: ((event: UiEvent) => void) | null = null;
let eventSocket: WebSocket | null = null;

function sessionToken(): string {
  return new URLSearchParams(location.search).get("token") ?? "";
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${sessionToken()}`);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw new Error(
      await response.text() || `${response.status} ${response.statusText}`,
    );
  }
  return await response.json() as T;
}

function connectEvents(): void {
  if (eventSocket || !sessionToken()) return;
  const url = new URL("/api/events", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", sessionToken());
  eventSocket = new WebSocket(url);
  eventSocket.onmessage = (event) => dispatchEvent(event.data as string);
  eventSocket.onclose = () => {
    eventSocket = null;
    dispatchHandler?.({ type: "connection", status: "disconnected" });
  };
}

function parseJson<T>(value: string | T): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function normalizePeers(peers: readonly PeerPresence[]): PeerPresence[] {
  return peers.map((peer) => ({ ...peer, filename: basename(peer.filename) }));
}

export function normalizeBootstrapState(state: BootstrapState): BootstrapState {
  return {
    ...state,
    filename: basename(state.filename),
    peers: normalizePeers(state.peers),
  };
}

export function toUint8Array(value: NativeBytes): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function setEventHandler(
  handler: ((event: UiEvent) => void) | null,
): void {
  dispatchHandler = handler;
}

export const dispatchEvent = (value: UiEvent | string): void => {
  const event = parseJson<UiEvent>(value);
  if (event.type === "state") {
    dispatchHandler?.({
      ...event,
      state: normalizeBootstrapState(event.state),
    });
  } else if (event.type === "presence") {
    dispatchHandler?.({ ...event, peers: normalizePeers(event.peers) });
  } else if (event.type === "sync") {
    dispatchHandler?.({
      ...event,
      filename: basename(event.filename),
      message: toUint8Array(event.message),
    });
  } else {
    dispatchHandler?.(event);
  }
};

export async function bootstrap(): Promise<BootstrapState> {
  try {
    const state = await apiJson<BootstrapState>("/api/bootstrap");
    connectEvents();
    return normalizeBootstrapState(state);
  } catch {
    return {
      instanceId: "preview",
      name: "You",
      filename: "Untitled",
      path: null,
      markdown: "# Untitled\n\nStart writing…",
      recentFiles: [],
      status: "disconnected",
      peers: [],
    };
  }
}

export async function openPath(path: string): Promise<BootstrapState> {
  const state = await apiJson<BootstrapState>("/api/open", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return normalizeBootstrapState(state);
}

export async function save(
  path: string | null,
  markdown: string,
): Promise<BootstrapState> {
  const state = await apiJson<BootstrapState>("/api/save", {
    method: "POST",
    body: JSON.stringify({ path, markdown }),
  });
  return normalizeBootstrapState(state);
}

export async function rename(name: string): Promise<void> {
  await apiJson("/api/name", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function retryConnection(): Promise<void> {
  await apiJson("/api/retry", { method: "POST" });
}

export async function pushSync(
  filename: string,
  message: Uint8Array,
): Promise<Uint8Array | null> {
  const response = await fetch("/api/sync", {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken()}`,
      "content-type": "application/octet-stream",
      "x-editing-filename": basename(filename),
    },
    body: new Uint8Array(message).buffer,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204
    ? null
    : new Uint8Array(await response.arrayBuffer());
}

export async function selectPeer(
  id: string,
): Promise<{ filename: string; markdown: string }> {
  const state = await apiJson<{ filename: string; markdown: string }>(
    "/api/peer",
    {
      method: "POST",
      body: JSON.stringify({ id }),
    },
  );
  return { ...state, filename: basename(state.filename) };
}
