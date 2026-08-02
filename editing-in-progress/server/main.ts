import { createLocalHandler } from "./app/api.ts";
import { LocalApplication } from "./app/local_app.ts";
import { LocalDocument } from "./app/local_document.ts";
import { AppPersistence } from "./app/persistence.ts";
import { parseMode } from "./cli.ts";
import { loadOrCreateConfig, parseListenAddress } from "./config_file.ts";
import { type CollabSession, createHttpHandler } from "./http/mod.ts";
import { CoordinatorClient } from "./network/client.ts";
import { Coordinator } from "./network/coordinator.ts";
import type { Config } from "./core/config.ts";
import { openNativeWindow } from "./window.ts";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function startCoordinator(
  config: Config,
  signal?: AbortSignal,
): Deno.HttpServer {
  const coordinator = new Coordinator({
    secret: config.secret,
    salt: config.scramSalt,
    iterations: config.scramIterations,
  });
  coordinator.startExpiryTimer();
  const sessions = {
    onConnect(session: CollabSession) {
      coordinator.connect(session);
    },
    onMessage(session: CollabSession, message: string | Uint8Array) {
      return coordinator.receive(session, message);
    },
    onClose(session: CollabSession) {
      coordinator.disconnect(session);
    },
    onError(session: CollabSession) {
      coordinator.disconnect(session);
    },
  };
  const listen = parseListenAddress(config.listenAddress);
  const server = Deno.serve(
    {
      hostname: listen.hostname,
      port: listen.port,
      signal,
      onListen: ({ hostname, port }) =>
        console.log(`coordinator listening on ${hostname}:${port}`),
    },
    createHttpHandler({ sessions, maxWebSocketMessageBytes: 16 * 1024 * 1024 }),
  );
  void server.finished.finally(() => coordinator.stopExpiryTimer());
  return server;
}

export async function runEditor(
  config: Config,
  openWindow: (url: string) => Promise<void> = openNativeWindow,
): Promise<void> {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is required");
  const persisted = await AppPersistence.load(home, config.instanceId);
  const recovery = persisted.state.recovery;
  const document = recovery
    ? LocalDocument.load(recovery.snapshot)
    : LocalDocument.create();
  const app = new LocalApplication(
    config.instanceId,
    config.displayName,
    document,
    persisted.state.recentFiles,
    persisted.persistence,
    { dirty: recovery?.dirty ?? false, unsynced: recovery?.unsynced ?? false },
  );
  const client = new CoordinatorClient({
    url: config.coordinatorUrl,
    instanceId: config.instanceId,
    secret: config.secret,
    expectedSalt: config.scramSalt,
    expectedIterations: config.scramIterations,
    events: {
      onStatus: (status) => app.setConnectionStatus(status),
      onPresence: (peers) => app.replacePresence(peers),
      onPeer: (peer) => app.updatePresence(peer),
      onRemoteDocument: (ownerId, name, filename, snapshot) =>
        app.updateRemote(ownerId, name, filename, snapshot),
      onViewExpired: (ownerId) => app.expireRemote(ownerId),
    },
  });
  app.setCoordinator(client);
  await client.updateOwner(
    config.displayName,
    app.bootstrap().filename,
    app.ownerSnapshot(),
  );
  client.start();

  const token = randomToken();
  const localServer = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    createLocalHandler({ app, token }),
  );
  const address = localServer.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${address.port}/?token=${token}`;
  try {
    await openWindow(url);
  } finally {
    client.stop();
    await persisted.persistence.flush();
    await localServer.shutdown();
  }
}

export async function main(
  args = Deno.args,
  openWindow: (url: string) => Promise<void> = openNativeWindow,
): Promise<void> {
  const mode = parseMode(args);
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is required");
  const loaded = await loadOrCreateConfig(home);
  if (loaded.created) {
    console.log(`created private configuration at ${loaded.path}`);
  }
  if (mode === "serve") {
    await startCoordinator(loaded.config).finished;
    return;
  }
  if (mode === "edit-and-serve") {
    const controller = new AbortController();
    const server = startCoordinator(loaded.config, controller.signal);
    try {
      await runEditor(loaded.config, openWindow);
    } finally {
      controller.abort();
      await server.finished;
    }
    return;
  }
  await runEditor(loaded.config, openWindow);
}

if (import.meta.main) {
  await main();
}
