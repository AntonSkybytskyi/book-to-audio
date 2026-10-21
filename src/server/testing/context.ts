import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { ChapterQueue } from "../books/queue.js";
import { Storage } from "../books/storage.js";
import { ChunkStore } from "../convert/chunk-store.js";
import { createChapterConverter } from "../convert/convert-chapter.js";
import { PoolStateStore } from "../convert/pool-state.js";
import { WorkerPool } from "../convert/pool.js";
import { openDatabase } from "../db/database.js";
import { parseEpubFile } from "../epub/parse.js";
import { EventBus } from "../events/bus.js";
import { SettingsStore } from "../settings/settings.js";
import { fakeEncode, fakeJoin } from "./fake-codec.js";
import { FakeEngine, type FakeEngineOptions } from "../tts/fake.js";

export interface TestContext {
  db: Database.Database;
  storage: Storage;
  engine: FakeEngine;
  dataDir: string;
  bus: EventBus;
  settings: SettingsStore;
  /** A real pool that has not been started: no worker runs unless a test calls `start()`. */
  pool: WorkerPool;
  /** Parses in this thread; the app itself uses a worker thread, which tests do not need. */
  parseEpub: typeof parseEpubFile;
  cleanup(): void;
}

/** A real database and data directory in a temp folder, with a fake TTS engine. */
export function createTestContext(engineOptions?: FakeEngineOptions): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-to-audio-test-"));
  const dataDir = path.join(root, "data");
  const db = openDatabase(dataDir);
  const storage = new Storage(dataDir);
  const engine = new FakeEngine(engineOptions);
  const bus = new EventBus();
  const settings = new SettingsStore(db, { cpus: 4 });
  const pool = new WorkerPool({
    queue: new ChapterQueue(db),
    converter: createChapterConverter({
      engine,
      storage,
      chunks: new ChunkStore(storage),
      encode: fakeEncode,
      join: fakeJoin,
      retryDelaysMs: [0, 0, 0],
    }),
    engine,
    state: new PoolStateStore(db),
    settings,
    bus,
  });
  return {
    db,
    dataDir,
    storage,
    engine,
    bus,
    settings,
    pool,
    parseEpub: parseEpubFile,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
