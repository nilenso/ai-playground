import { createDatabase } from "./db";
import { loadConfig } from "./config";
import { generateJwt } from "./auth";
import { createApp } from "./server";
import type { Hono } from "hono";

const DEFAULT_CONFIG = "fivetwo.config.json";

function getConfigPath(): string {
  const configIndex = Bun.argv.indexOf("--config");
  if (configIndex !== -1 && Bun.argv[configIndex + 1]) {
    return Bun.argv[configIndex + 1]!;
  }
  return DEFAULT_CONFIG;
}

function printUsage(): void {
  console.log(`Usage: bun src/index.ts <command> [options]

Commands:
  mkconfig          Create a new ${DEFAULT_CONFIG} in the current directory
  mkhuman <name>    Create a human user
  mkagent <name>    Create an AI agent user
  auth <username>   Generate a JWT token for the specified user
  serve             Start the server (default if no command given)

Options:
  --config <path>   Path to config file (default: ${DEFAULT_CONFIG})

Examples:
  bun src/index.ts mkconfig
  bun src/index.ts mkhuman alice
  bun src/index.ts mkagent bot
  bun src/index.ts auth alice
  bun src/index.ts serve
  bun src/index.ts serve --config /path/to/config.json
`);
}

// Get command (first non-flag argument after script name)
const args = Bun.argv.slice(2);
const command = args.find(
  (arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--")
);

async function main(): Promise<Hono | undefined> {
  // Handle mkconfig command (doesn't need existing config)
  if (command === "mkconfig") {
    const configPath = getConfigPath();
    const file = Bun.file(configPath);

    if (await file.exists()) {
      console.error(`Error: ${configPath} already exists`);
      process.exit(1);
    }

    // Generate a random 32-byte secret
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const jwtSecret = Buffer.from(randomBytes).toString("base64");

    const config = {
      db: "./data.db",
      jwtSecret,
    };

    await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`Created ${configPath}`);
    process.exit(0);
  }

  // Handle help
  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // Check for unknown commands before loading config
  const validCommands = ["mkhuman", "mkagent", "auth", "serve", undefined];
  if (!validCommands.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  // All other commands need config
  const configPath = getConfigPath();
  const config = await loadConfig(configPath);
  const db = createDatabase(config.db);

  // Handle mkhuman command
  if (command === "mkhuman") {
    const usernameIndex = args.indexOf("mkhuman") + 1;
    const username = args[usernameIndex];

    if (!username || username.startsWith("--")) {
      console.error("Error: mkhuman requires a username");
      console.error("Usage: bun src/index.ts mkhuman <username>");
      process.exit(1);
    }

    try {
      db.run("INSERT INTO users (username, type) VALUES (?, ?)", [username, "human"]);
      console.log(`Created human user: ${username}`);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        console.error(`Error: User '${username}' already exists`);
        process.exit(1);
      }
      throw e;
    }
    process.exit(0);
  }

  // Handle mkagent command
  if (command === "mkagent") {
    const usernameIndex = args.indexOf("mkagent") + 1;
    const username = args[usernameIndex];

    if (!username || username.startsWith("--")) {
      console.error("Error: mkagent requires a username");
      console.error("Usage: bun src/index.ts mkagent <username>");
      process.exit(1);
    }

    try {
      db.run("INSERT INTO users (username, type) VALUES (?, ?)", [username, "ai"]);
      console.log(`Created AI agent user: ${username}`);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        console.error(`Error: User '${username}' already exists`);
        process.exit(1);
      }
      throw e;
    }
    process.exit(0);
  }

  // Handle auth command
  if (command === "auth") {
    const usernameIndex = args.indexOf("auth") + 1;
    const username = args[usernameIndex];

    if (!username || username.startsWith("--")) {
      console.error("Error: auth requires a username");
      console.error("Usage: bun src/index.ts auth <username>");
      process.exit(1);
    }

    const user = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get(username);

    if (!user) {
      console.error(`Error: User '${username}' not found`);
      process.exit(1);
    }

    const token = await generateJwt(config.jwtSecret, user.id);
    console.log(token);
    process.exit(0);
  }

  // Default: serve
  return createApp({ db, jwtSecret: config.jwtSecret });
}

export default await main();
