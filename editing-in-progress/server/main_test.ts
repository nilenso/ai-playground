import { acquireEditorLock, main } from "./main.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("editor lock prevents two processes from using one installation identity", async () => {
  const home = await Deno.makeTempDir({ prefix: "editing-in-progress-lock-" });
  const first = await acquireEditorLock(home);
  try {
    let rejected = false;
    try {
      await acquireEditorLock(home);
    } catch (error) {
      rejected = error instanceof Error &&
        error.message.includes("already running");
    }
    assert(rejected, "a second editor acquired the installation lock");
  } finally {
    first.close();
  }
  const replacement = await acquireEditorLock(home);
  replacement.close();
  await Deno.remove(home, { recursive: true });
});

Deno.test("edit --serve opens the authenticated local UI through the injected window", async () => {
  const home = await Deno.makeTempDir({ prefix: "editing-in-progress-main-" });
  const previousHome = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    await main(["edit", "--serve"], async (url) => {
      const response = await fetch(url);
      assert(response.ok, `local UI returned ${response.status}`);
      assert(
        (await response.text()).includes("Editing in Progress"),
        "local UI title missing",
      );
    });
  } finally {
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
    await Deno.remove(home, { recursive: true });
  }
});
