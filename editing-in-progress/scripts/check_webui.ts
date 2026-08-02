import { WebUI } from "@webui/deno-webui";

const window = new WebUI();
window.setPublic(false);
window.setSize(1180, 800);
window.setCenter();
WebUI.clean();
console.log("Pinned Deno-WebUI sidecar initialized without network access");
