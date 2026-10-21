import os from "node:os";
import { fileURLToPath } from "node:url";
import nextModule from "next";
import { buildServer } from "./app.js";
import { concatWebm, encodeWebm } from "./audio/ffmpeg.js";
import { ChapterQueue } from "./books/queue.js";
import { sweepStorage } from "./books/sweep.js";
import { Storage } from "./books/storage.js";
import { loadConfig } from "./config.js";
import { ChunkStore } from "./convert/chunk-store.js";
import { createChapterConverter } from "./convert/convert-chapter.js";
import { PoolStateStore } from "./convert/pool-state.js";
import { WorkerPool } from "./convert/pool.js";
import { openDatabase } from "./db/database.js";
import { EventBus } from "./events/bus.js";
import { SettingsStore } from "./settings/settings.js";
import { PiperEngine } from "./tts/piper.js";
import { createEngine } from "./tts/index.js";

// `next` is CommonJS with `module.exports = createServer`, so under NodeNext the
// default import is the function at runtime but is typed as the module namespace.
// This file is type-checked only by tsconfig.server.json (NodeNext) for that reason.
const next = nextModule as unknown as typeof nextModule.default;

// Same depth from src/server (tsx) and dist/server (built).
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);

  const nextApp = next({
    dev: config.dev,
    dir: projectRoot,
    hostname: config.host,
    port: config.port,
  });
  await nextApp.prepare();

  const storage = new Storage(config.dataDir);
  const swept = sweepStorage(db, storage);
  const engine = createEngine(config);
  if (engine instanceof PiperEngine) engine.removeLeftovers();
  const bus = new EventBus();
  const settings = new SettingsStore(db, {
    cpus: os.availableParallelism(),
    envWorkers: config.workers,
  });
  // `app` is created right below; the pool only logs through it once started.
  const logger = {
    info: (m: string) => app.log.info(m),
    warn: (c: object, m: string) => app.log.warn(c, m),
    error: (c: object, m: string) => app.log.error(c, m),
  };
  const queue = new ChapterQueue(db);
  // Workers never create a book's audio folder (so a deleted book stays deleted); queued books get it here.
  for (const id of queue.activeBookIds()) storage.ensureAudioDir(id);
  const encoder = { ffmpegBin: config.ffmpegBin, bitrate: config.opusBitrate };
  const pool = new WorkerPool({
    queue,
    converter: createChapterConverter({
      engine,
      storage,
      chunks: new ChunkStore(storage, { minFreeBytes: config.minFreeDiskMb * 1024 ** 2 }),
      encode: (pcm, outputPath, signal) => encodeWebm(pcm, outputPath, encoder, signal),
      join: (files, outputPath, signal, fallbackSeconds) =>
        concatWebm(files, outputPath, encoder, signal, fallbackSeconds),
      logger,
    }),
    engine,
    state: new PoolStateStore(db),
    settings,
    bus,
    logger,
  });
  const app = buildServer({
    db,
    nextHandler: nextApp.getRequestHandler(),
    logger: true,
    storage,
    engine,
    maxUploadBytes: config.maxUploadMb * 1024 * 1024,
    allowedHosts: config.allowedHosts,
    bus,
    pool,
    settings,
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info(`${signal} received, shutting down`);
    // Long-lived responses can keep the server open; don't wait past Docker's stop timeout.
    setTimeout(() => process.exit(1), 8000).unref();
    let code = 0;
    try {
      await pool.stop();
      await app.close();
      await nextApp.close();
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      code = 1;
    } finally {
      db.close();
    }
    process.exit(code);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (swept.orphanDirs + swept.tempFiles + swept.partsDirs > 0) {
    app.log.info(swept, "removed leftovers of an interrupted run");
  }
  // Interrupted chapters are re-queued before the first request can see them as running.
  pool.start();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `data directory: ${config.dataDir}, TTS engine: ${engine.id}, workers: ${pool.status().workers}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
