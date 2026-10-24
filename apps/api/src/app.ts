import multipart from "@fastify/multipart";
import type Database from "better-sqlite3";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { PoolControl } from "./convert/pool.js";
import type { EventBus } from "./events/bus.js";
import { BookControls } from "./books/controls.js";
import { ChapterQueue } from "./books/queue.js";
import { BookRepository } from "./books/repository.js";
import { BookTransitions } from "./books/transitions.js";
import type { Storage } from "./books/storage.js";
import type { ParsedEpub } from "./epub/types.js";
import type { OutputBuilder } from "./outputs/builder.js";
import { createWorkerParser } from "./epub/worker-parser.js";
import { QuietLogController } from "./logging.js";
import { registerBookControlRoutes } from "./routes/book-controls.js";
import { registerBookRoutes } from "./routes/books.js";
import { registerConfigRoute } from "./routes/config.js";
import { registerDownloadRoutes } from "./routes/downloads.js";
import { registerErrorHandler } from "./routes/errors.js";
import { registerBenchmarkRoutes } from "./routes/benchmark.js";
import { registerEstimateRoute } from "./routes/estimate.js";
import { registerEventsRoute, type EventStreamLimits } from "./routes/events.js";
import { registerPoolRoutes } from "./routes/pool.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpload } from "./routes/upload.js";
import type { SettingsStore } from "./settings/settings.js";
import { BenchmarkRepository, type MachineInfo } from "./benchmark/repository.js";
import type { BenchmarkRunner } from "./benchmark/runner.js";
import { CountRepository } from "./books/count-repository.js";
import { PreparedCounter } from "./books/prepared-counter.js";
import { prepareInThread, type TextPreparer } from "./convert/chapter-text.js";
import { SpeedCalibration } from "./speed/calibration.js";
import { Estimator } from "./speed/estimator.js";
import { LearningRepository } from "./speed/learning.js";
import { API_SECURITY_HEADERS, registerHostAndOriginGuard } from "./security.js";
import type { TtsCatalog } from "./tts/catalog.js";
import { benchmarkWorkersOf, workersOf } from "./convert/worker-target.js";

export interface ServerDeps {
  db: Database.Database;
  logger?: FastifyServerOptions["logger"];
  storage: Storage;
  /** The configured TTS services and the voice of each language. */
  catalog: TtsCatalog;
  /** Upload size limit in bytes, enforced while the file streams in. */
  maxUploadBytes: number;
  /** Where the queue and pool publish live updates; `GET /api/events` streams them. */
  bus: EventBus;
  pool: PoolControl;
  /** Builds the M4B and ZIP of finished books. */
  outputs: Pick<OutputBuilder, "request" | "cancel" | "filesMissing">;
  settings: SettingsStore;
  /** Limits of the event stream; the defaults suit the app, tests shorten them. */
  eventStream?: EventStreamLimits;
  /** Host names besides localhost that the app answers to. */
  allowedHosts?: readonly string[];
  /** The speed benchmark, with the machine it measures; without it the benchmark routes are not served. */
  benchmark?: { runner: BenchmarkRunner; machine: () => MachineInfo };
  /** The text rules, for the estimates. Production passes the worker thread one. */
  prepareText?: TextPreparer;
  /** Counts the prepared text of new books in the background. Made here when not given. */
  counter?: PreparedCounter;
  /** Parses a stored upload. Defaults to a worker thread with a memory cap; replaced in tests. */
  parseEpub?: (filePath: string) => Promise<ParsedEpub>;
}

// A 200 MB upload on a slow disk, then parsing, can take minutes without a byte on the socket.
const REQUEST_TIMEOUT_MS = 15 * 60_000;
const CONNECTION_TIMEOUT_MS = 20 * 60_000;
const HEADERS_TIMEOUT_MS = 30_000;

const notFound = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.code(404).send({
    statusCode: 404,
    error: "Not Found",
    message: `Route ${req.method}:${req.url} not found`,
  });

export function buildServer({
  db,
  logger = false,
  storage,
  catalog,
  maxUploadBytes,
  bus,
  pool,
  outputs,
  settings,
  eventStream = {},
  allowedHosts = [],
  benchmark,
  prepareText = prepareInThread,
  counter = new PreparedCounter({
    repo: new CountRepository(db),
    prepare: prepareText,
    maxChars: (language) => catalog.maxCharsFor(language),
    bus,
  }),
  parseEpub = createWorkerParser(),
}: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger,
    logController: new QuietLogController(),
    // "2" is not 2 and an unknown field is a mistake: reject them instead of quietly fixing the body.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;
  const repo = new BookRepository(db);
  const queue = new ChapterQueue(db);
  const controls = new BookControls({
    repo,
    queue,
    transitions: new BookTransitions(db, queue),
    storage,
    bus,
    pool,
    outputs,
    logger: app.log,
  });

  const estimator = new Estimator({
    catalog,
    calibration: new SpeedCalibration(new BenchmarkRepository(db), new LearningRepository(db)),
    workers: workersOf(catalog, settings),
    poolPaused: (service) => {
      const status = pool.status();
      return (
        status.state === "paused" ||
        status.services.some((s) => s.id === service && s.state === "paused")
      );
    },
    speedTestSeconds: () =>
      benchmark && pool.status().held ? benchmark.runner.expectedRemainingSeconds() : null,
  });

  registerHostAndOriginGuard(app, allowedHosts);

  app.register(
    async (api) => {
      // Taken before the handler reads anything, so a snapshot never claims to include an
      // event that it does not: the client drops events up to this number and applies the rest.
      api.addHook("onRequest", async (_req, reply) => {
        reply.header("X-Event-Seq", String(bus.currentSeq));
      });
      api.addHook("onSend", async (_req, reply, payload) => {
        reply.headers(API_SECURITY_HEADERS);
        return payload;
      });
      registerErrorHandler(api);
      registerConfigRoute(api, { maxUploadBytes });
      await api.register(multipart, {
        limits: { fileSize: maxUploadBytes, files: 1, fields: 5, parts: 6 },
      });
      registerUpload(api, { repo, storage, catalog, bus, parseEpub, estimator, counter });
      registerBookRoutes(api, { repo, storage, catalog, bus, pool, estimator, counter });
      registerEstimateRoute(api, {
        repo,
        counts: new CountRepository(db),
        catalog,
        estimator,
        prepareText: counter.prepare,
      });
      registerBookControlRoutes(api, { repo, catalog, controls, estimator });
      registerDownloadRoutes(api, { repo, storage, catalog, outputs, estimator });
      registerPoolRoutes(api, pool);
      registerSettingsRoutes(api, { settings, catalog, pool });
      if (benchmark) {
        registerBenchmarkRoutes(api, {
          runner: benchmark.runner,
          repo: new BenchmarkRepository(db),
          catalog,
          workers: benchmarkWorkersOf(catalog, settings),
          machine: benchmark.machine,
        });
      }
      registerEventsRoute(api, { bus, pool, ...eventStream });

      api.get("/health", async (req, reply) => {
        try {
          db.prepare("SELECT 1").get();
          return { status: "ok", db: "ok" };
        } catch (error) {
          req.log.error({ err: error }, "database health check failed");
          return reply.code(503).send({ status: "error", db: "error" });
        }
      });

      api.all("/", notFound);
      api.all("/*", notFound);
    },
    { prefix: "/api" },
  );

  // The pages are served by the web app; nginx sends only `/api` here.
  app.setNotFoundHandler(notFound);

  return app;
}
