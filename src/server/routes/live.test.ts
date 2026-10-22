import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../app.js";
import type { EventStreamLimits } from "./events.js";
import { PoolStateStore } from "../convert/pool-state.js";
import { EventBus, type AppEvent } from "../events/bus.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { tick, until } from "../testing/pool-harness.js";

const parse = (text: string): AppEvent[] =>
  text
    .split("\n\n")
    .map((block) => /^data: (.*)$/m.exec(block)?.[1])
    .filter((data): data is string => data !== undefined)
    .map((data) => JSON.parse(data) as AppEvent);

const statusOf = (port: number, headers: http.OutgoingHttpHeaders = {}) =>
  new Promise<number>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy(); // a stream that was accepted is not read
    });
    req.on("error", (error) => {
      // Cut off before any answer: 0, like a refused connection.
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(0);
      else reject(error);
    });
  });

describe("live updates and pool routes", () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  const build = (limits: EventStreamLimits = {}) =>
    buildServer({
      db: ctx.db,
      nextHandler: async (_req, res) => {
        res.end();
      },
      storage: ctx.storage,
      engine: ctx.engine,
      maxUploadBytes: 1024 * 1024,
      parseEpub: ctx.parseEpub,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
      eventStream: { heartbeatMs: 15, ...limits },
    });

  beforeEach(() => {
    ctx = createTestContext();
    app = build();
  });

  afterEach(async () => {
    await app.close();
    ctx.cleanup();
  });

  const patch = (payload: unknown) =>
    app.inject({ method: "PATCH", url: "/api/settings", payload: payload as object });

  const listen = async () => {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    return app.server.address() as AddressInfo;
  };

  /** A TCP client that asks for the stream and then never reads, as a stalled browser would. */
  const stalled = async () => {
    const { port } = await listen();
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n");
    socket.pause();
    return socket;
  };
  /** An open event stream: collects what the server writes. */
  interface Stream {
    headers: http.IncomingHttpHeaders;
    status: number;
    text(): string;
    until(match: RegExp): Promise<void>;
    ended: Promise<void>;
    destroy(): void;
  }

  const connect = async (headers: http.OutgoingHttpHeaders = {}): Promise<Stream> => {
    const { port } = await listen();
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers }, (res) => {
        let text = "";
        const waiting = new Set<() => void>();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          for (const check of waiting) check();
        });
        const ended = new Promise<void>((done) => res.on("close", done));
        resolve({
          headers: res.headers,
          status: res.statusCode ?? 0,
          text: () => text,
          until: (match) =>
            new Promise<void>((done, fail) => {
              const check = () => {
                if (!match.test(text)) return;
                waiting.delete(check);
                done();
              };
              waiting.add(check);
              ended.then(() => fail(new Error(`stream ended before ${match}: ${text}`)));
              check();
            }),
          ended,
          destroy: () => req.destroy(),
        });
      });
      req.on("error", reject);
    });
  };

  describe("GET /api/events", () => {
    it("is an event stream with the API security headers, and starts with the pool state", async () => {
      const stream = await connect();

      await stream.until(/event: pool/);

      expect(stream.status).toBe(200);
      expect(stream.headers).toMatchObject({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-content-type-options": "nosniff",
        "x-accel-buffering": "no",
      });
      expect(stream.text()).toMatch(/^retry: 3000\n\n/);
      expect(parse(stream.text())[0]).toEqual({
        type: "pool",
        state: "running",
        error: null,
        cause: null,
        workers: 2,
        activeWorkers: 0,
      });
      stream.destroy();
    });

    it("delivers each published event as `event: <type>` with one line of JSON", async () => {
      const stream = await connect();
      await stream.until(/event: pool/);

      ctx.bus.publish({ type: "book-added", bookId: "abc" });
      ctx.bus.publish({
        type: "chapter",
        bookId: "abc",
        position: 2,
        status: "generating",
        progress: 0.5,
        error: null,
        durationSeconds: null,
        chunkCount: 8,
        chunksDone: 4,
        audioVersion: null,
        regenError: null,
      });
      await stream.until(/event: chapter/);

      expect(stream.text()).toContain(
        'event: book-added\ndata: {"type":"book-added","bookId":"abc"}\n\n',
      );
      expect(parse(stream.text()).at(-1)).toMatchObject({
        type: "chapter",
        position: 2,
        progress: 0.5,
      });
      stream.destroy();
    });

    it("sends a heartbeat comment", async () => {
      const stream = await connect();

      await stream.until(/: ping\n\n/);

      expect(stream.text()).toMatch(/: ping\n\n/);
      stream.destroy();
    });

    it("stops listening when the client goes away", async () => {
      const stream = await connect();
      await stream.until(/event: pool/);
      expect(ctx.bus.listenerCount).toBe(1);

      stream.destroy();
      await stream.ended;

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctx.bus.listenerCount).toBe(0);
    });

    it("lets app.close() finish while streams are open, and ends them", async () => {
      const a = await connect();
      const b = await connect();
      await Promise.all([a.until(/event: pool/), b.until(/event: pool/)]);

      await app.close();

      await Promise.all([a.ended, b.ended]);
      expect(ctx.bus.listenerCount).toBe(0);
    });

    it("numbers every message, and the first one says which events came before it", async () => {
      ctx.bus.publish({ type: "book-added", bookId: "before" });
      const before = ctx.bus.currentSeq;
      const stream = await connect();
      await stream.until(/event: pool/);

      ctx.bus.publish({ type: "book-added", bookId: "after" });
      await stream.until(/after/);

      const ids = [...stream.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual([before, before + 1]);
      stream.destroy();
    });

    it("refuses a page of another origin", async () => {
      const { port } = await listen();

      expect(await statusOf(port, { origin: "https://evil.example" })).toBe(403);
      expect(await statusOf(port, { origin: `http://127.0.0.1:${port}` })).toBe(200);
      expect(ctx.bus.listenerCount).toBe(1);
    });

    it("refuses new listeners beyond the limit, and takes them again when one leaves", async () => {
      await app.close();
      app = build({ maxStreams: 2 });
      const { port } = await listen();
      const first = await connect();
      const second = await connect();
      await Promise.all([first.until(/event: pool/), second.until(/event: pool/)]);

      expect(await statusOf(port)).toBe(429);
      first.destroy();
      await first.ended;
      await until(() => ctx.bus.listenerCount === 1);

      expect(await statusOf(port)).toBe(200);
      second.destroy();
    });

    it("frees the slot and the subscription when the stream cannot be set up", async () => {
      await app.close();
      app = build({ maxStreams: 1 });
      const { port } = await listen();
      vi.spyOn(ctx.pool, "status").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });

      const failed = await statusOf(port).catch(() => 0);

      expect(failed === 200 || failed === 0).toBe(true);
      await until(() => ctx.bus.listenerCount === 0);
      expect(await statusOf(port)).toBe(200); // the single slot is free again
    });

    it("does not keep a slot for a client that left before the stream started", async () => {
      await app.close();
      app = build({ maxStreams: 1 });
      const { port } = await listen();

      for (let i = 0; i < 25; i++) {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.write("GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n");
        socket.destroy(); // gone before, or while, the server starts the stream
      }
      await until(() => ctx.bus.listenerCount === 0);

      expect(await statusOf(port)).toBe(200);
    });

    describe("a client that does not read", () => {
      const BIG = "x".repeat(100_000);
      const flood = async (count: number, pace = false) => {
        for (let i = 0; i < count; i++) {
          if (pace) await tick(); // lets a client that is reading keep up
          ctx.bus.publish({
            type: "chapter",
            bookId: "b",
            position: 1,
            status: "failed",
            progress: 0,
            error: BIG,
            durationSeconds: null,
            chunkCount: 0,
            chunksDone: 0,
            audioVersion: null,
            regenError: null,
          });
        }
      };
      const uncaught: unknown[] = [];
      const record = (error: unknown) => uncaught.push(error);

      beforeEach(async () => {
        uncaught.length = 0;
        process.on("uncaughtException", record);
        process.on("unhandledRejection", record);
        await app.close();
        app = build({ maxBufferedBytes: 512 * 1024 });
      });

      afterEach(() => {
        process.off("uncaughtException", record);
        process.off("unhandledRejection", record);
      });

      it("is cut off, and the heartbeat and later events do not crash the process", async () => {
        const socket = await stalled();
        await until(() => ctx.bus.listenerCount === 1);

        await flood(60); // far more than the socket and its buffers hold
        await until(() => ctx.bus.listenerCount === 0);
        // The heartbeat timer and further events must find nothing left to write to.
        await new Promise((resolve) => setTimeout(resolve, 60));
        await flood(3);
        ctx.bus.publish({ type: "book-added", bookId: "late" });

        expect(uncaught).toEqual([]);
        expect(ctx.bus.listenerCount).toBe(0);
        socket.destroy();
      });

      it("does not keep the other streams from getting their events", async () => {
        const reader = await connect();
        const socket = await stalled();
        await until(() => ctx.bus.listenerCount === 2);

        await flood(60, true);
        ctx.bus.publish({ type: "book-added", bookId: "still-here" });
        await reader.until(/still-here/);

        expect(uncaught).toEqual([]);
        reader.destroy();
        socket.destroy();
      });

      it("survives a shutdown with a stalled client and events still being published", async () => {
        const socket = await stalled();
        await until(() => ctx.bus.listenerCount === 1);
        await flood(60);

        const closing = app.close();
        await flood(2); // events during shutdown
        await closing;
        await new Promise((resolve) => setTimeout(resolve, 40)); // past a few heartbeats

        expect(uncaught).toEqual([]);
        expect(ctx.bus.listenerCount).toBe(0);
        socket.destroy();
      });
    });

    it("refuses a request that another site started", async () => {
      const { port } = await listen();

      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port,
              path: "/api/events",
              headers: { "sec-fetch-site": "cross-site" },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          )
          .on("error", reject);
      });

      expect(status).toBe(403);
      expect(ctx.bus.listenerCount).toBe(0);
    });

    it("applies the Host check like every other route", async () => {
      const res = await app.inject({ url: "/api/events", headers: { host: "evil.example" } });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("sequence numbers on answers", () => {
    it("tell a client which events an answer can already include", async () => {
      ctx.bus.publish({ type: "book-added", bookId: "x" });
      const seq = ctx.bus.currentSeq;

      const books = await app.inject({ url: "/api/books" });
      const pool = await app.inject({ url: "/api/pool" });
      ctx.bus.publish({ type: "book-added", bookId: "y" });
      const later = await app.inject({ url: "/api/pool" });

      expect(books.headers["x-event-seq"]).toBe(String(seq));
      expect(pool.headers["x-event-seq"]).toBe(String(seq));
      expect(later.headers["x-event-seq"]).toBe(String(seq + 1));
    });

    it("grow across restarts, so a new server never looks older than the one before", () => {
      const first = new EventBus(() => 1_800_000_000_000);
      for (let i = 0; i < 5000; i++) first.publish({ type: "book-added", bookId: "x" });
      const second = new EventBus(() => 1_800_000_001_000);

      expect(second.currentSeq).toBeGreaterThan(first.currentSeq);
      expect(Number.isSafeInteger(second.currentSeq + 1_000_000)).toBe(true);
    });
  });

  describe("pool", () => {
    it("reports the state, the worker count and the busy workers", async () => {
      const res = await app.inject({ url: "/api/pool" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        state: "running",
        error: null,
        cause: null,
        workers: 2,
        activeWorkers: 0,
      });
    });

    it("resumes a paused pool and tells listeners", async () => {
      const state = new PoolStateStore(ctx.db);
      for (const message of ["a", "b", "Engine is down."]) state.recordFailure(message);
      expect((await app.inject({ url: "/api/pool" })).json()).toMatchObject({
        state: "paused",
        error: "Engine is down.",
      });
      const seen: AppEvent[] = [];
      ctx.bus.subscribe((event) => seen.push(event));

      const res = await app.inject({ method: "POST", url: "/api/pool/resume" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "running", error: null });
      expect(seen).toContainEqual(expect.objectContaining({ type: "pool", state: "running" }));
      expect(state.get()).toEqual({
        state: "running",
        error: null,
        cause: null,
        consecutiveFailures: 0,
      });
    });

    it("answers 200 when there is nothing to resume", async () => {
      const res = await app.inject({ method: "POST", url: "/api/pool/resume" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "running" });
    });

    it("rejects a resume from another site", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/pool/resume",
        headers: { "sec-fetch-site": "cross-site" },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("settings", () => {
    it("reports the worker count, its range and the default", async () => {
      const res = await app.inject({ url: "/api/settings" });

      expect(res.json()).toEqual({
        workers: 2,
        maxWorkers: 4,
        defaultWorkers: 2,
        shownLanguages: ["en", "uk"],
      });
    });

    it("changes the worker count of the running pool and keeps it", async () => {
      const seen: AppEvent[] = [];
      ctx.bus.subscribe((event) => seen.push(event));

      const up = await patch({ workers: 4 });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toMatchObject({ workers: 4 });
      expect(ctx.pool.status().workers).toBe(4);
      expect(seen).toContainEqual(expect.objectContaining({ type: "pool", workers: 4 }));

      const down = await patch({ workers: 1 });
      expect(down.json()).toMatchObject({ workers: 1 });
      expect(ctx.pool.status().workers).toBe(1);
      expect((await app.inject({ url: "/api/settings" })).json()).toMatchObject({ workers: 1 });
    });

    it.each([
      ["zero", { workers: 0 }],
      ["negative", { workers: -1 }],
      ["above the number of cores", { workers: 5 }],
      ["a fraction", { workers: 1.5 }],
      ["a string", { workers: "2" }],
      ["null", { workers: null }],
      ["an unknown setting", { workers: 2, colour: "red" }],
      ["nothing", {}],
    ])("rejects %s and changes nothing", async (_name, payload) => {
      const res = await patch(payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
      expect(ctx.pool.status().workers).toBe(2);
      expect(ctx.settings.workers()).toBe(2);
    });
  });
});
