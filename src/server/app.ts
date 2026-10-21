import type { IncomingMessage, ServerResponse } from "node:http";
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
import { BookRepository } from "./books/repository.js";
import type { Storage } from "./books/storage.js";
import type { ParsedEpub } from "./epub/types.js";
import { createWorkerParser } from "./epub/worker-parser.js";
import { QuietLogController } from "./logging.js";
import { registerBookRoutes } from "./routes/books.js";
import { registerConfigRoute } from "./routes/config.js";
import { registerErrorHandler } from "./routes/errors.js";
import { registerEventsRoute, type EventStreamLimits } from "./routes/events.js";
import { registerPoolRoutes } from "./routes/pool.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpload } from "./routes/upload.js";
import type { SettingsStore } from "./settings/settings.js";
import { API_SECURITY_HEADERS, registerHostAndOriginGuard } from "./security.js";
import type { TtsEngine } from "./tts/engine.js";

export type NextHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface ServerDeps {
  db: Database.Database;
  /** Handles every request outside `/api`, normally Next.js `getRequestHandler()`. */
  nextHandler: NextHandler;
  logger?: FastifyServerOptions["logger"];
  storage: Storage;
  engine: TtsEngine;
  /** Upload size limit in bytes, enforced while the file streams in. */
  maxUploadBytes: number;
  /** Where the queue and pool publish live updates; `GET /api/events` streams them. */
  bus: EventBus;
  pool: PoolControl;
  settings: SettingsStore;
  /** Limits of the event stream; the defaults suit the app, tests shorten them. */
  eventStream?: EventStreamLimits;
  /** Host names besides localhost that the app answers to. */
  allowedHosts?: readonly string[];
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
  nextHandler,
  logger = false,
  storage,
  engine,
  maxUploadBytes,
  bus,
  pool,
  settings,
  eventStream = {},
  allowedHosts = [],
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
      registerUpload(api, { repo, storage, engine, bus, parseEpub });
      registerBookRoutes(api, { repo, storage, engine, bus, pool });
      registerPoolRoutes(api, pool);
      registerSettingsRoutes(api, { settings, pool });
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

  app.register(async (web) => {
    // Leave request bodies unread so Next.js can consume the raw stream.
    web.removeAllContentTypeParsers();
    web.addContentTypeParser("*", (_req, _payload, done) => done(null));

    web.all("/*", async (req, reply) => {
      reply.hijack();
      try {
        await nextHandler(req.raw, reply.raw);
      } catch (error) {
        // Fastify cannot reply on a hijacked response, so end it here.
        req.log.error({ err: error }, "Next.js request handler failed");
        if (!reply.raw.headersSent) reply.raw.statusCode = 500;
        reply.raw.end();
      }
    });
  });

  return app;
}
