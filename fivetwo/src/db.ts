import { Database } from "bun:sqlite";

export function createDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA journal_mode = WAL;");
  return db;
}
