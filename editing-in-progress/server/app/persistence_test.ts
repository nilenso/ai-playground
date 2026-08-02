import { AppPersistence } from "./persistence.ts";

Deno.test("app persistence restores only owner recovery and local MRU", async () => {
  const home = await Deno.makeTempDir();
  const instanceId = "d9428888-122b-4fee-9bb0-d7c1651c1f8b";
  try {
    const first = await AppPersistence.load(home, instanceId);
    await first.persistence.touchLocal(`${home}/notes.md`);
    first.persistence.scheduleRecovery(new Uint8Array([1, 2, 3]), true, true);
    await first.persistence.flush();
    const restored = await AppPersistence.load(home, instanceId);
    if (!restored.state.recovery?.dirty || !restored.state.recovery.unsynced) {
      throw new Error("recovery flags were lost");
    }
    if (restored.state.recovery.snapshot.join(",") !== "1,2,3") {
      throw new Error("snapshot was lost");
    }
    if (restored.state.recentFiles[0] !== `${home}/notes.md`) {
      throw new Error("MRU was lost");
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
