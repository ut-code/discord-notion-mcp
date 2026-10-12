import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type AppDatabase = BunSQLiteDatabase<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database;
  db: AppDatabase;
}

/** Resolved from the working directory: the bundled server no longer sits next to the sources. */
const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export function runAppMigrations(db: AppDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
