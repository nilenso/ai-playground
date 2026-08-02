import {
  MruState,
  readMru,
  readRecovery,
  type RecoveryV1,
  statePath,
  writeMruAtomic,
  writeRecoveryAtomic,
} from "../state/storage.ts";

export interface LoadedLocalState {
  recovery: RecoveryV1 | null;
  recentFiles: string[];
}

export class AppPersistence {
  readonly recoveryPath: string;
  readonly mruPath: string;
  #instanceId: string;
  #roomId: string;
  #mru: MruState;
  #timer?: number;
  #pending?: { snapshot: Uint8Array; dirty: boolean; unsynced: boolean };

  private constructor(
    home: string,
    instanceId: string,
    roomId: string,
    mru: MruState,
  ) {
    const root = statePath(home);
    this.recoveryPath = `${root}/recovery.bin`;
    this.mruPath = `${root}/mru.bin`;
    this.#instanceId = instanceId;
    this.#roomId = roomId;
    this.#mru = mru;
  }

  static async load(
    home: string,
    instanceId: string,
  ): Promise<{ persistence: AppPersistence; state: LoadedLocalState }> {
    const root = statePath(home);
    let recovery: RecoveryV1 | null = null;
    let mru = new MruState();
    try {
      recovery = await readRecovery(`${root}/recovery.bin`, instanceId);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
      mru = await readMru(`${root}/mru.bin`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const roomId = recovery?.roomUuid ?? crypto.randomUUID();
    return {
      persistence: new AppPersistence(home, instanceId, roomId, mru),
      state: { recovery, recentFiles: [...mru.entries] },
    };
  }

  setRoom(roomId: string): void {
    this.#roomId = roomId;
  }

  async touchLocal(path: string): Promise<void> {
    this.#mru.touchLocal(path);
    await writeMruAtomic(this.mruPath, this.#mru);
  }

  scheduleRecovery(
    snapshot: Uint8Array,
    dirty: boolean,
    unsynced: boolean,
  ): void {
    this.#pending = { snapshot: snapshot.slice(), dirty, unsynced };
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), 250);
  }

  async flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    if (!pending.dirty && !pending.unsynced) {
      await Deno.remove(this.recoveryPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      return;
    }
    await writeRecoveryAtomic(this.recoveryPath, {
      instanceUuid: this.#instanceId,
      roomUuid: this.#roomId,
      serverEpoch: null,
      snapshot: pending.snapshot,
      dirty: pending.dirty,
      unsynced: pending.unsynced,
      updatedTimestamp: Date.now(),
    }, this.#instanceId);
  }
}
