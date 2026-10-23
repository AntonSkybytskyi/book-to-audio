import os from "node:os";
import path from "node:path";
import { buildServer } from "./app.js";
import { concatWebm, encodeWebm } from "./audio/ffmpeg.js";
import { BenchmarkRepository } from "./benchmark/repository.js";
import { currentMachine, removeBenchmarkLeftovers } from "./benchmark/machine.js";
import { BenchmarkRunner } from "./benchmark/runner.js";
import { CountRepository } from "./books/count-repository.js";
import { PreparedCounter } from "./books/prepared-counter.js";
import { ChapterQueue } from "./books/queue.js";
import { BookRepository } from "./books/repository.js";
import { sweepStorage } from "./books/sweep.js";
import { Storage } from "./books/storage.js";
import { loadConfig } from "./config.js";
import { ChunkStore } from "./convert/chunk-store.js";
import { createChapterConverter } from "./convert/convert-chapter.js";
import { prepareChunks } from "./convert/chapter-text.js";
import { createTextPreparer } from "./convert/text-preparer.js";
import { PoolStateStore } from "./convert/pool-state.js";
import { WorkerPool } from "./convert/pool.js";
import { openDatabase } from "./db/database.js";
import { EventBus } from "./events/bus.js";
import { OutputBuilder } from "./outputs/builder.js";
import { findNice } from "./outputs/nice.js";
import { createOutputProducer } from "./outputs/produce.js";
import { OutputRepository } from "./outputs/repository.js";
import { TEXT_PROCESSING_VERSION } from "./text/index.js";
import { SettingsStore } from "./settings/settings.js";
import { SpeedCalibration } from "./speed/calibration.js";
import { LearningRepository } from "./speed/learning.js";
import { SpeedLearning } from "./speed/learner.js";
import { PiperEngine } from "./tts/piper.js";
import { createEngine } from "./tts/index.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);

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
  const prepareText = createTextPreparer();
  const countRepo = new CountRepository(db);
  // Counting the prepared text of a book is slow work for a big one, so it runs after the upload is answered.
  const counter = new PreparedCounter({
    repo: countRepo,
    prepare: prepareText,
    maxChars: engine.maxInputChars,
    bus,
    onIdle: (): void => pool.recheckIdle(),
    logger,
  });
  const benchmarks = new BenchmarkRepository(db);
  const learning = new LearningRepository(db);
  const pool = new WorkerPool({
    queue,
    converter: createChapterConverter({
      engine,
      storage,
      chunks: new ChunkStore(storage, { minFreeBytes: config.minFreeDiskMb * 1024 ** 2 }),
      encode: (pcm, outputPath, signal) => encodeWebm(pcm, outputPath, encoder, signal),
      join: (files, outputPath, signal, fallbackSeconds) =>
        concatWebm(files, outputPath, encoder, signal, fallbackSeconds),
      prepareText,
      logger,
    }),
    engine,
    state: new PoolStateStore(db),
    settings,
    bus,
    logger,
    busyElsewhere: (): boolean => outputs.anyBusy || counter.busy,
    learner: new SpeedLearning(engine.id, new SpeedCalibration(benchmarks, learning), learning),
  });
  // Piper's scratch folders and the benchmark's share this parent.
  const scratchDir = path.join(config.dataDir, "tmp");
  removeBenchmarkLeftovers(scratchDir);
  const benchmark = new BenchmarkRunner({
    engine,
    repo: benchmarks,
    pool,
    bus,
    workers: () => ({ current: settings.workers(), max: settings.maxWorkers }),
    scratchDir,
    machine: currentMachine,
    prepare: prepareChunks,
    encode: (pcm, outputPath, signal) => encodeWebm(pcm, outputPath, encoder, signal),
    now: () => performance.now(),
    logger,
  });
  const outputs = new OutputBuilder({
    books: new BookRepository(db),
    outputs: new OutputRepository(db),
    storage,
    producer: createOutputProducer({
      storage,
      ffmpegBin: config.ffmpegBin,
      ffprobeBin: config.ffprobeBin,
      m4bBitrate: config.m4bBitrate,
      niceBin: findNice(),
      minFreeBytes: config.minFreeDiskMb * 1024 ** 2,
      logger,
    }),
    bus,
    logger,
    onIdle: (): void => pool.recheckIdle(),
    hold: (): boolean => pool.status().held,
  });
  const app = buildServer({
    db,
    logger: true,
    storage,
    engine,
    maxUploadBytes: config.maxUploadMb * 1024 * 1024,
    allowedHosts: config.allowedHosts,
    bus,
    pool,
    outputs,
    settings,
    benchmark: { runner: benchmark, machine: currentMachine },
    prepareText,
    counter,
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info(`${signal} received, shutting down`);
    // Long-lived responses can keep the server open; don't wait past Docker's stop timeout.
    setTimeout(() => process.exit(1), 8000).unref();
    let code = 0;
    try {
      await benchmark.shutdown();
      await counter.stop();
      await pool.stop();
      await outputs.stop();
      await app.close();
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

  if (swept.orphanDirs + swept.tempFiles + swept.partsDirs + swept.buildDirs > 0) {
    app.log.info(swept, "removed leftovers of an interrupted run");
  }
  // Interrupted chapters are re-queued before the first request can see them as running.
  pool.start();
  outputs.start();
  await app.listen({ host: config.host, port: config.port });
  // Books from before the counts were kept, or counted under older text rules, are counted now; the
  // benchmark waits for a moment when nothing is being read.
  if (countRepo.resetCountsIfRulesChanged(TEXT_PROCESSING_VERSION) === "changed") {
    app.log.info("the text rules changed: counting the prepared text of unfinished books again");
  }
  counter.backfill();
  if (benchmark.startIfNeeded()) app.log.info("a speed test will run once nothing is being read");
  app.log.info(
    `data directory: ${config.dataDir}, TTS engine: ${engine.id}, workers: ${pool.status().workers}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
