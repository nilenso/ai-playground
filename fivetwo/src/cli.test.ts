import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { Database } from "bun:sqlite";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
const TEST_DIR = join(import.meta.dir, "..", "test-tmp");

async function runCli(
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: options?.cwd ?? TEST_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function cleanup(...files: string[]) {
  for (const file of files) {
    try {
      await unlink(file);
    } catch {
      // ignore
    }
  }
}

describe("CLI: mkconfig", () => {
  const configPath = join(TEST_DIR, "fivetwo.config.json");

  beforeAll(async () => {
    await Bun.$`mkdir -p ${TEST_DIR}`;
  });

  beforeEach(async () => {
    await cleanup(configPath);
  });

  afterAll(async () => {
    await cleanup(configPath);
  });

  test("creates config file with valid structure", async () => {
    const { stdout, exitCode } = await runCli(["mkconfig"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created fivetwo.config.json");

    const config = await Bun.file(configPath).json();
    expect(config.db).toBe("./data.db");
    expect(config.jwtSecret).toBeDefined();
    expect(config.jwtSecret.length).toBeGreaterThanOrEqual(32);
  });

  test("fails if config already exists", async () => {
    // Create initial config
    await Bun.write(configPath, JSON.stringify({ db: "./test.db", jwtSecret: "x".repeat(32) }));

    const { stderr, exitCode } = await runCli(["mkconfig"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  test("respects --config flag for custom path", async () => {
    const customPath = join(TEST_DIR, "custom.config.json");
    await cleanup(customPath);

    const { stdout, exitCode } = await runCli(["mkconfig", "--config", customPath]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created");

    const config = await Bun.file(customPath).json();
    expect(config.db).toBe("./data.db");

    await cleanup(customPath);
  });
});

describe("CLI: mkhuman", () => {
  const configPath = join(TEST_DIR, "fivetwo.config.json");
  const dbPath = join(TEST_DIR, "test-mkhuman.db");

  beforeAll(async () => {
    await Bun.$`mkdir -p ${TEST_DIR}`;
    await cleanup(configPath, dbPath);

    // Create config
    const config = { db: dbPath, jwtSecret: "x".repeat(32) };
    await Bun.write(configPath, JSON.stringify(config));

    // Create database with schema
    const db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
        email TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.close();
  });

  afterAll(async () => {
    await cleanup(configPath, dbPath);
  });

  test("creates human user", async () => {
    const { stdout, exitCode } = await runCli(["mkhuman", "alice"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created human user: alice");

    // Verify in database
    const db = new Database(dbPath);
    const user = db.query("SELECT * FROM users WHERE username = ?").get("alice") as {
      username: string;
      type: string;
    };
    expect(user.username).toBe("alice");
    expect(user.type).toBe("human");
    db.close();
  });

  test("fails on duplicate username", async () => {
    // alice was created in previous test
    const { stderr, exitCode } = await runCli(["mkhuman", "alice"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  test("fails without username argument", async () => {
    const { stderr, exitCode } = await runCli(["mkhuman"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires a username");
  });
});

describe("CLI: mkagent", () => {
  const configPath = join(TEST_DIR, "fivetwo.config.json");
  const dbPath = join(TEST_DIR, "test-mkagent.db");

  beforeAll(async () => {
    await Bun.$`mkdir -p ${TEST_DIR}`;
    await cleanup(configPath, dbPath);

    // Create config
    const config = { db: dbPath, jwtSecret: "x".repeat(32) };
    await Bun.write(configPath, JSON.stringify(config));

    // Create database with schema
    const db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
        email TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.close();
  });

  afterAll(async () => {
    await cleanup(configPath, dbPath);
  });

  test("creates AI agent user", async () => {
    const { stdout, exitCode } = await runCli(["mkagent", "bot"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created AI agent user: bot");

    // Verify in database
    const db = new Database(dbPath);
    const user = db.query("SELECT * FROM users WHERE username = ?").get("bot") as {
      username: string;
      type: string;
    };
    expect(user.username).toBe("bot");
    expect(user.type).toBe("ai");
    db.close();
  });

  test("fails on duplicate username", async () => {
    const { stderr, exitCode } = await runCli(["mkagent", "bot"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  test("fails without username argument", async () => {
    const { stderr, exitCode } = await runCli(["mkagent"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires a username");
  });
});

describe("CLI: auth", () => {
  const configPath = join(TEST_DIR, "fivetwo.config.json");
  const dbPath = join(TEST_DIR, "test-auth.db");

  beforeAll(async () => {
    await Bun.$`mkdir -p ${TEST_DIR}`;
    await cleanup(configPath, dbPath);

    // Create config
    const config = { db: dbPath, jwtSecret: "a]7#K!zP2$mN9@qR4&wX6^cV8*fB0+dL".repeat(1) };
    await Bun.write(configPath, JSON.stringify(config));

    // Create database with schema and user
    const db = new Database(dbPath, { create: true });
    db.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
        email TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run("INSERT INTO users (username, type) VALUES (?, ?)", ["testuser", "human"]);
    db.close();
  });

  afterAll(async () => {
    await cleanup(configPath, dbPath);
  });

  test("generates JWT for existing user", async () => {
    const { stdout, exitCode } = await runCli(["auth", "testuser"]);

    expect(exitCode).toBe(0);

    // Verify it's a valid JWT (three base64 parts separated by dots)
    const token = stdout.trim();
    const parts = token.split(".");
    expect(parts.length).toBe(3);

    // Decode and verify payload
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString());
    expect(payload.sub).toBe(1); // user ID
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  test("fails for non-existent user", async () => {
    const { stderr, exitCode } = await runCli(["auth", "nobody"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("fails without username argument", async () => {
    const { stderr, exitCode } = await runCli(["auth"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires a username");
  });
});

describe("CLI: help", () => {
  test("shows usage with --help", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("mkconfig");
    expect(stdout).toContain("mkhuman");
    expect(stdout).toContain("mkagent");
    expect(stdout).toContain("auth");
    expect(stdout).toContain("serve");
  });

  test("shows usage with help command", async () => {
    const { stdout, exitCode } = await runCli(["help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });
});

describe("CLI: unknown command", () => {
  test("shows error for unknown command", async () => {
    const { stderr, exitCode } = await runCli(["unknowncommand"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
