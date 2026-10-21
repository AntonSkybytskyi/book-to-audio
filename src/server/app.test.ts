import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer, type NextHandler } from "./app.js";
import { createTestContext, type TestContext } from "./testing/context.js";

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

describe("buildServer", () => {
  let ctx: TestContext;
  let db: Database.Database;
  let app: FastifyInstance;
  const nextHandler = vi.fn<NextHandler>(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`next:${req.method} ${req.url} ${body}`);
  });

  beforeEach(() => {
    ctx = createTestContext();
    db = ctx.db;
    nextHandler.mockClear();
    app = buildServer({
      db,
      nextHandler,
      storage: ctx.storage,
      engine: ctx.engine,
      maxUploadBytes: 1024 * 1024,
      parseEpub: ctx.parseEpub,
    });
  });

  afterEach(async () => {
    await app.close();
    ctx.cleanup();
  });

  it("reports health from GET /api/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("reports an unhealthy database", async () => {
    db.close();

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "error", db: "error" });
  });

  it("returns JSON 404 for unknown /api routes without calling Next", async () => {
    const res = await app.inject({ method: "POST", url: "/api/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404 });
    expect(nextHandler).not.toHaveBeenCalled();
  });

  it("returns JSON 404 for /api itself", async () => {
    const res = await app.inject({ method: "GET", url: "/api" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404 });
    expect(nextHandler).not.toHaveBeenCalled();
  });

  it("answers 500 when the Next handler fails", async () => {
    nextHandler.mockRejectedValueOnce(new Error("boom"));

    const res = await app.inject({ method: "GET", url: "/broken" });

    expect(res.statusCode).toBe(500);
  });

  it("refuses a Host that is not local, for Next pages as well as the API", async () => {
    const page = await app.inject({ url: "/", headers: { host: "evil.example" } });
    const api = await app.inject({ url: "/api/health", headers: { host: "evil.example:3000" } });

    expect(page.statusCode).toBe(403);
    expect(api.statusCode).toBe(403);
    expect(nextHandler).not.toHaveBeenCalled();
  });

  it("refuses a cross-site POST before Next reads the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/form",
      headers: { origin: "https://evil.example" },
      payload: "a=1",
    });

    expect(res.statusCode).toBe(403);
    expect(nextHandler).not.toHaveBeenCalled();
  });

  it("answers the Docker health check, which uses 127.0.0.1", async () => {
    const res = await app.inject({ url: "/api/health", headers: { host: "127.0.0.1:3000" } });

    expect(res.statusCode).toBe(200);
  });

  const captureLogs = async (requests: { method: "GET" | "POST"; url: string }[]) => {
    const lines: Record<string, unknown>[] = [];
    const server = buildServer({
      db,
      nextHandler,
      storage: ctx.storage,
      engine: ctx.engine,
      maxUploadBytes: 1024,
      parseEpub: ctx.parseEpub,
      logger: {
        level: "info",
        stream: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      },
    });
    for (const request of requests) await server.inject(request);
    await server.close();
    return lines;
  };

  describe("request logging", () => {
    it("does not log successful GET requests such as the 2 second polls", async () => {
      const lines = await captureLogs([
        { method: "GET", url: "/api/health" },
        { method: "GET", url: "/api/books" },
      ]);

      expect(lines.filter((l) => l.msg === "request")).toEqual([]);
      expect(lines.some((l) => "req" in l || "res" in l)).toBe(false);
    });

    it("logs one short line for a rejected request", async () => {
      const lines = await captureLogs([{ method: "POST", url: "/api/nope?secret=1" }]);

      const line = lines.find((l) => l.msg === "request rejected");
      expect(line).toMatchObject({ method: "POST", url: "/api/nope", status: 404 });
      expect(line).not.toHaveProperty("req");
    });
  });

  it("hands every other request to Next", async () => {
    const res = await app.inject({ method: "GET", url: "/books/1?x=y" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("next:GET /books/1?x=y ");
  });

  it("hands / to Next", async () => {
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toBe("next:GET / ");
  });

  it("leaves request bodies unread for Next", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/form",
      headers: { "content-type": "application/json" },
      payload: '{"a":1}',
    });

    expect(res.body).toBe('next:POST /form {"a":1}');
  });
});
