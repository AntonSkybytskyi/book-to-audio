import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Storage } from "../books/storage.js";
import { openDatabase } from "../db/database.js";
import { parseEpubFile } from "../epub/parse.js";
import { FakeEngine, type FakeEngineOptions } from "../tts/fake.js";

export interface TestContext {
  db: Database.Database;
  storage: Storage;
  engine: FakeEngine;
  dataDir: string;
  /** Parses in this thread; the app itself uses a worker thread, which tests do not need. */
  parseEpub: typeof parseEpubFile;
  cleanup(): void;
}

/** A real database and data directory in a temp folder, with a fake TTS engine. */
export function createTestContext(engineOptions?: FakeEngineOptions): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-to-audio-test-"));
  const dataDir = path.join(root, "data");
  const db = openDatabase(dataDir);
  return {
    db,
    dataDir,
    storage: new Storage(dataDir),
    engine: new FakeEngine(engineOptions),
    parseEpub: parseEpubFile,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
