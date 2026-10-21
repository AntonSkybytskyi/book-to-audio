import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

export type NextHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface ServerDeps {
  db: Database.Database;
  /** Handles every request outside `/api`, normally Next.js `getRequestHandler()`. */
  nextHandler: NextHandler;
  logger?: FastifyServerOptions["logger"];
}

const notFound = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.code(404).send({
    statusCode: 404,
    error: "Not Found",
    message: `Route ${req.method}:${req.url} not found`,
  });

export function buildServer({ db, nextHandler, logger = false }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger });

  app.register(
    async (api) => {
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
