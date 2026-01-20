import { resolve, dirname } from "path";

export interface Config {
  db: string;
  jwtSecret: string;
}

export async function loadConfig(configPath: string): Promise<Config> {
  const absoluteConfigPath = resolve(configPath);
  const file = Bun.file(absoluteConfigPath);

  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${absoluteConfigPath}`);
  }

  const raw = await file.json();

  // Validate required fields
  if (!raw.db || typeof raw.db !== "string") {
    throw new Error("Config: 'db' path is required");
  }
  if (!raw.jwtSecret || typeof raw.jwtSecret !== "string") {
    throw new Error("Config: 'jwtSecret' is required");
  }
  if (raw.jwtSecret.length < 32) {
    throw new Error("Config: 'jwtSecret' must be at least 32 characters");
  }

  // Resolve db path relative to config file location
  const configDir = dirname(absoluteConfigPath);
  const dbPath = raw.db.startsWith("/") ? raw.db : resolve(configDir, raw.db);

  return {
    db: dbPath,
    jwtSecret: raw.jwtSecret,
  };
}
