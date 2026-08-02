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

export async function openNativeWindow(url: string): Promise<void> {
  if (!isLocalWindowUrl(url)) {
    throw new Error("refusing to open a non-loopback or untrusted window URL");
  }
  const { WebUI } = await import("@webui/deno-webui");
  const window = new WebUI();
  window.setPublic(false);
  window.setSize(1180, 800);
  window.setCenter();
  try {
    if (!window.showWebView(url)) await window.show(url);
    await WebUI.wait();
  } finally {
    WebUI.clean();
  }
}
