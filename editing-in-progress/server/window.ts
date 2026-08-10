export function isLocalWindowUrl(value: string): boolean {
  if (value.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
    !url.port || url.pathname !== "/" || url.username || url.password ||
    url.hash || [...url.searchParams.keys()].some((key) => key !== "token")
  ) return false;
  const token = url.searchParams.getAll("token");
  return token.length === 1 && /^[A-Za-z0-9_-]{32,128}$/.test(token[0]);
}

async function waitForShutdownSignal(): Promise<void> {
  const signals = ["SIGINT", "SIGTERM"] as const;
  await new Promise<void>((resolve) => {
    const finish = () => {
      for (const signal of signals) Deno.removeSignalListener(signal, finish);
      resolve();
    };
    for (const signal of signals) Deno.addSignalListener(signal, finish);
  });
}

function openLinuxBrowserWindow(url: string): boolean {
  const browsers: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "google-chrome",
      [`--app=${url}`, "--new-window", "--window-size=1180,800"],
    ],
    ["firefox", ["--new-window", url]],
  ];
  for (const [command, args] of browsers) {
    try {
      const browser = new Deno.Command(command, {
        args: [...args],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      browser.unref();
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}

export async function openNativeWindow(url: string): Promise<void> {
  if (!isLocalWindowUrl(url)) {
    throw new Error("refusing to open a non-loopback or untrusted window URL");
  }
  const { WebUI } = await import("@webui/deno-webui");
  if (Deno.build.os === "linux") {
    // The GTK WebView deadlocks with a loopback server in this Deno process.
    // Open the system browser without WebUI's bridge handshake and keep the
    // local service alive until the command receives Ctrl-C or SIGTERM.
    try {
      if (!openLinuxBrowserWindow(url)) WebUI.openUrl(url);
      await waitForShutdownSignal();
    } finally {
      WebUI.clean();
    }
    return;
  }

  const window = new WebUI();
  window.setPublic(false);
  window.setSize(1180, 800);
  window.setCenter();
  try {
    if (window.showWebView(url)) {
      await WebUI.wait();
    } else {
      // Safari is not a WebUI-managed browser, but the editor only needs its
      // authenticated loopback HTTP API. Use the macOS default browser (Safari
      // on a stock installation) when WKWebView is unavailable.
      WebUI.openUrl(url);
      await waitForShutdownSignal();
    }
  } finally {
    WebUI.clean();
  }
}
