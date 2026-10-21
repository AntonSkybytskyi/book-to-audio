import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";
import { migrations } from "./migrations.js";

export const DATA_SUBDIRS = ["books", "audio"] as const;

/** Creates the data directory layout, opens `app.db` and brings its schema up to date. */
export function openDatabase(dataDir: string): Database.Database {
  // Owner-only: books and audio are private to the user running the app.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const dir of DATA_SUBDIRS)
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true, mode: 0o700 });

  const db = new Database(path.join(dataDir, "app.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    runMigrations(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
