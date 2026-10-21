import { fileURLToPath } from "node:url";
import nextModule from "next";
import { buildServer } from "./app.js";
import { encodeWebm } from "./audio/ffmpeg.js";
import { ChapterQueue } from "./books/queue.js";
import { sweepStorage } from "./books/sweep.js";
import { Storage } from "./books/storage.js";
import { loadConfig } from "./config.js";
import { createChapterConverter } from "./convert/convert-chapter.js";
import { Scheduler } from "./convert/scheduler.js";
import { openDatabase } from "./db/database.js";
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
  const app = buildServer({
    db,
    nextHandler: nextApp.getRequestHandler(),
    logger: true,
    storage,
    engine,
    maxUploadBytes: config.maxUploadMb * 1024 * 1024,
    allowedHosts: config.allowedHosts,
    // `scheduler` is created right below, before the first request can arrive.
    onQueued: () => scheduler.notify(),
  });

  const scheduler = new Scheduler({
    queue: new ChapterQueue(db),
    convert: createChapterConverter({
      engine,
      storage,
      encode: (pcm, outputPath, signal) =>
        encodeWebm(
          pcm,
          outputPath,
          { ffmpegBin: config.ffmpegBin, bitrate: config.opusBitrate },
          signal,
        ),
    }),
    logger: app.log,
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info(`${signal} received, shutting down`);
    // Long-lived responses can keep the server open; don't wait past Docker's stop timeout.
    setTimeout(() => process.exit(1), 8000).unref();
    let code = 0;
    try {
      await scheduler.stop();
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

  if (swept.orphanDirs + swept.tempFiles > 0) {
    app.log.info(swept, "removed leftovers of an interrupted run");
  }
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`data directory: ${config.dataDir}, TTS engine: ${engine.id}`);
  scheduler.start();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
