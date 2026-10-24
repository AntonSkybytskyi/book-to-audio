import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import { Storage } from "../books/storage.js";
import { ChunkStore } from "../convert/chunk-store.js";
import { createChapterConverter } from "../convert/convert-chapter.js";
import { PoolStateStore } from "../convert/pool-state.js";
import { WorkerPool } from "../convert/pool.js";
import { openDatabase } from "../db/database.js";
import { parseEpubFile } from "../epub/parse.js";
import { EventBus } from "../events/bus.js";
import { OutputBuilder } from "../outputs/builder.js";
import { OutputRepository } from "../outputs/repository.js";
import { SettingsStore } from "../settings/settings.js";
import { TtsCatalog } from "../tts/catalog.js";
import { fakeEncode, fakeJoin } from "./fake-codec.js";
import { fakeProducer } from "./fake-outputs.js";
import { FakeEngine, type FakeEngineOptions } from "./fake-engine.js";

export interface TestContext {
  db: Database.Database;
  storage: Storage;
  engine: FakeEngine;
  /** The catalog of that one engine. */
  catalog: TtsCatalog;
  dataDir: string;
  bus: EventBus;
  settings: SettingsStore;
  /** A real output builder with a fake producer. It listens to the bus only after a test calls `start()`. */
  outputs: OutputBuilder;
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
  const settings = new SettingsStore(db);
  const catalog = new TtsCatalog([engine], { chosenVoice: (language) => settings.voice(language) });
  const pool = new WorkerPool({
    queue: new ChapterQueue(db),
    converter: createChapterConverter({
      catalog,
      storage,
      chunks: new ChunkStore(storage),
      encode: fakeEncode,
      join: fakeJoin,
      retryDelaysMs: [0, 0, 0],
    }),
    catalog,
    state: new PoolStateStore(db),
    settings,
    bus,
  });
  const outputs = new OutputBuilder({
    books: new BookRepository(db),
    outputs: new OutputRepository(db),
    storage,
    producer: fakeProducer,
    bus,
  });
  return {
    db,
    dataDir,
    storage,
    engine,
    catalog,
    bus,
    settings,
    outputs,
    pool,
    parseEpub: parseEpubFile,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
