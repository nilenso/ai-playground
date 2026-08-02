import {
  configPath,
  decodeMru,
  decodeRecovery,
  encodeMru,
  encodeRecovery,
  MAX_MRU_ENTRIES,
  MAX_RECOVERY_FILE_BYTES,
  MruState,
  readMru,
  readRecovery,
  type RecoveryV1,
  statePath,
  StateValidationError,
  validateRecovery,
  writeMruAtomic,
  writeRecoveryAtomic,
} from "./storage.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (Object.is(actual, expected)) return;
  const stringify = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? `${item}n` : item,
    );
  if (stringify(actual) !== stringify(expected)) {
    throw new Error(
      `expected ${stringify(expected)}, got ${stringify(actual)}`,
    );
  }
}

async function assertRejectsCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof StateValidationError, String(error));
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function fixture(overrides: Partial<RecoveryV1> = {}): RecoveryV1 {
  return {
    instanceUuid: "11111111-1111-4111-8111-111111111111",
    roomUuid: "22222222-2222-4222-8222-222222222222",
    serverEpoch: 42n,
    snapshot: new Uint8Array([0, 1, 2, 255]),
    dirty: true,
    unsynced: true,
    updatedTimestamp: 1_900_000_000,
    ...overrides,
  };
}

Deno.test("application paths derive only from an absolute home", () => {
  if (Deno.build.os === "windows") return;
  assertEquals(
    configPath("/home/alice"),
    "/home/alice/.config/editing-in-progress/config.toml",
  );
  assertEquals(
    statePath("/home/alice"),
    "/home/alice/.local/share/editing-in-progress",
  );
  for (const derive of [configPath, statePath]) {
    try {
      derive("relative/home");
      throw new Error("expected invalid home");
    } catch (error) {
      assert(error instanceof StateValidationError);
      assertEquals(error.code, "INVALID_PATH");
    }
  }
});

Deno.test("owner recovery binary round trips only the narrow schema", () => {
  const value = fixture();
  const decoded = decodeRecovery(encodeRecovery(value));
  assertEquals(decoded.instanceUuid, value.instanceUuid);
  assertEquals(decoded.roomUuid, value.roomUuid);
  assertEquals(decoded.serverEpoch, value.serverEpoch);
  assertEquals([...decoded.snapshot], [...value.snapshot]);
  assertEquals(decoded.dirty, true);
  assertEquals(decoded.unsynced, true);
  assertEquals(decoded.updatedTimestamp, value.updatedTimestamp);
});

Deno.test("recovery validation rejects non-owner and private or remote metadata", () => {
  validateRecovery(fixture(), "11111111-1111-4111-8111-111111111111");
  try {
    validateRecovery(fixture(), "33333333-3333-4333-8333-333333333333");
    throw new Error("expected owner rejection");
  } catch (error) {
    assert(error instanceof StateValidationError);
    assertEquals(error.code, "NOT_LOCAL_OWNER");
  }
  for (
    const key of [
      "secret",
      "derivedAuth",
      "presence",
      "remoteMetadata",
      "remoteDocument",
      "localPath",
    ]
  ) {
    const unsafe = { ...fixture(), [key]: "must-not-persist" };
    try {
      validateRecovery(unsafe as RecoveryV1);
      throw new Error(`expected rejection for ${key}`);
    } catch (error) {
      assert(error instanceof StateValidationError);
      assertEquals(error.code, "UNEXPECTED_FIELD");
    }
  }
});

Deno.test("recovery decoder strictly rejects malformed and trailing data", () => {
  const bytes = encodeRecovery(fixture());
  bytes[0] ^= 0xff;
  try {
    decodeRecovery(bytes);
    throw new Error("expected invalid magic");
  } catch (error) {
    assert(error instanceof StateValidationError);
    assertEquals(error.code, "INVALID_MAGIC");
  }
  const valid = encodeRecovery(fixture());
  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  try {
    decodeRecovery(trailing);
    throw new Error("expected trailing data");
  } catch (error) {
    assert(error instanceof StateValidationError);
    assertEquals(error.code, "TRAILING_DATA");
  }
});

Deno.test("MRU allows only absolute local Markdown paths and is unique and bounded", () => {
  const mru = new MruState();
  mru.touchLocal("/home/alice/one.md");
  mru.touchLocal("/tmp/two.md");
  mru.touchLocal("/home/alice/one.md");
  assertEquals(mru.entries, ["/home/alice/one.md", "/tmp/two.md"]);
  for (
    const path of [
      "relative.md",
      "/tmp/no.txt",
      "https://host/doc.md",
      "remote:/doc.md",
      "room:abc.md",
    ]
  ) {
    try {
      mru.touchLocal(path);
      throw new Error(`expected rejection for ${path}`);
    } catch (error) {
      assert(error instanceof StateValidationError);
    }
  }
  for (let i = 0; i < MAX_MRU_ENTRIES + 2; i++) mru.touchLocal(`/tmp/${i}.md`);
  assertEquals(mru.entries.length, MAX_MRU_ENTRIES);
  assertEquals(mru.entries[0], `/tmp/${MAX_MRU_ENTRIES + 1}.md`);
  assertEquals(decodeMru(encodeMru(mru)).entries, mru.entries);
});

Deno.test("recovery and MRU files are atomically replaced and bounded", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const recoveryPath = `${dir}/nested/owner.recovery`;
    await writeRecoveryAtomic(
      recoveryPath,
      fixture(),
      "11111111-1111-4111-8111-111111111111",
    );
    await writeRecoveryAtomic(
      recoveryPath,
      fixture({ snapshot: new Uint8Array([9]), dirty: false }),
      "11111111-1111-4111-8111-111111111111",
    );
    const loaded = await readRecovery(
      recoveryPath,
      "11111111-1111-4111-8111-111111111111",
    );
    assertEquals([...loaded.snapshot], [9]);
    assertEquals(loaded.dirty, false);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(recoveryPath)).mode! & 0o777, 0o600);
    }

    const mruPath = `${dir}/mru.state`;
    const mru = new MruState(["/tmp/one.md", "/tmp/two.md"]);
    await writeMruAtomic(mruPath, mru);
    assertEquals((await readMru(mruPath)).entries, mru.entries);

    const oversized = `${dir}/oversized.recovery`;
    const file = await Deno.open(oversized, { create: true, write: true });
    try {
      await file.truncate(MAX_RECOVERY_FILE_BYTES + 1);
    } finally {
      file.close();
    }
    await assertRejectsCode(readRecovery(oversized), "FILE_TOO_LARGE");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
