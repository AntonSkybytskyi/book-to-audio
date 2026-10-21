import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer, type NextHandler } from "./app.js";

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

describe("buildServer", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  const nextHandler = vi.fn<NextHandler>(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`next:${req.method} ${req.url} ${body}`);
  });

  beforeEach(() => {
    db = new Database(":memory:");
    nextHandler.mockClear();
    app = buildServer({ db, nextHandler });
  });

  afterEach(async () => {
    await app.close();
    db.close();
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
    db = new Database(":memory:");
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
