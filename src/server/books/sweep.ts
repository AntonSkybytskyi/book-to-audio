import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Storage } from "./storage.js";

const PARTS = /^(\d+)\.parts$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SweepResult {
  /** Book or audio folders with no book in the database (an upload that died half way). */
  orphanDirs: number;
  /** Unfinished `*.tmp` audio files left by a crash during encoding. */
  tempFiles: number;
  /** `.parts` folders of chapters that are finished (their audio is encoded) or no longer exist. */
  partsDirs: number;
}

/**
 * Removes leftovers of a crash. Run once at startup, before anything writes.
 * Only folders named like a book id are touched; anything else is left alone.
 * Chunks of chapters that are queued, generating or failed are kept, to resume from.
 */
export function sweepStorage(db: Database.Database, storage: Storage): SweepResult {
  const known = new Set(db.prepare("SELECT id FROM books").pluck().all() as string[]);
  const result: SweepResult = { orphanDirs: 0, tempFiles: 0, partsDirs: 0 };
  const isOpen = db
    .prepare(
      `SELECT 1 FROM chapters
       WHERE book_id = ? AND position = ? AND status IN ('queued', 'generating', 'failed')`,
    )
    .pluck();

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
          const full = path.join(dir, file.name);
          const parts = PARTS.exec(file.name);
          if (file.isFile() && (file.name.endsWith(".tmp") || file.name.endsWith(".list"))) {
            fs.rmSync(full, { force: true });
            result.tempFiles++;
          } else if (file.isDirectory() && parts) {
            // Chunks of a chapter that will resume or be regenerated stay; the rest are leftovers.
            if (isOpen.get(entry.name, Number(parts[1]))) continue;
            fs.rmSync(full, { recursive: true, force: true });
            result.partsDirs++;
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
