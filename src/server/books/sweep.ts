import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Storage } from "./storage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SweepResult {
  /** Book or audio folders with no book in the database (an upload that died half way). */
  orphanDirs: number;
  /** Unfinished `*.tmp` audio files left by a crash during encoding. */
  tempFiles: number;
}

/**
 * Removes leftovers of a crash. Run once at startup, before anything writes.
 * Only folders named like a book id are touched; anything else is left alone.
 */
export function sweepStorage(db: Database.Database, storage: Storage): SweepResult {
  const known = new Set(db.prepare("SELECT id FROM books").pluck().all() as string[]);
  const result: SweepResult = { orphanDirs: 0, tempFiles: 0 };

  for (const area of ["books", "audio"] as const) {
    const root = path.join(storage.dataDir, area);
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      if (!known.has(entry.name)) {
        fs.rmSync(dir, { recursive: true, force: true });
        result.orphanDirs++;
      } else if (area === "audio") {
        for (const file of safeReaddir(dir)) {
          if (file.isFile() && file.name.endsWith(".tmp")) {
            fs.rmSync(path.join(dir, file.name), { force: true });
            result.tempFiles++;
          }
        }
      }
    }
  }
  return result;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
