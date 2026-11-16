import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const version of [1, 2]) {
    if (db.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(process.cwd(), `migrations/${String(version).padStart(3, "0")}.sql`), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)").run(version, Date.now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return db;
}
const globalDb = globalThis as unknown as { speechcutDb?: DatabaseSync };
export function database() { return globalDb.speechcutDb ??= openDatabase(config().dbPath); }
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
