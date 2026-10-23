import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `vi.waitFor` with room for a busy machine. */
const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 15_000 });
import { buildServer } from "../app.js";
import { BenchmarkRepository } from "../benchmark/repository.js";
import { BenchmarkRunner } from "../benchmark/runner.js";
import type { BenchmarkView } from "../benchmark/view.js";
import { prepareChunks } from "../convert/chapter-text.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { TimedEngine } from "../testing/timed-engine.js";
import { TtsCatalog } from "../tts/catalog.js";

const machine = { cpuCount: 8, cpuModel: "Test CPU" };

describe("benchmark routes", () => {
  let ctx: TestContext;
  let engine: TimedEngine;
  let catalog: TtsCatalog;
  let app: FastifyInstance;
  let runner: BenchmarkRunner;
  let scratch: string;
  let unstall: (() => void) | null = null;

  const stall = () => {
    engine.stall = new Promise<void>((resolve) => (unstall = resolve));
  };

  beforeEach(() => {
    ctx = createTestContext();
    engine = new TimedEngine({
      voices: [
        { id: "t-en", language: "en", name: "En", sampleRate: 22_050 },
        { id: "t-uk", language: "uk", name: "Uk", sampleRate: 22_050 },
      ],
      msPerChar: 12,
      audioPerChar: 0.06,
      concurrency: 2,
    });
    catalog = new TtsCatalog([engine]);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-route-"));
    runner = new BenchmarkRunner({
      catalog,
      repo: new BenchmarkRepository(ctx.db),
      pool: ctx.pool,
      bus: ctx.bus,
      workers: () => ({ current: 2, max: 2 }),
      scratchDir: scratch,
      machine: () => machine,
      prepare: prepareChunks,
      now: engine.now,
      loadAverage: () => 0, // the host's own load must not decide whether a run is due
    });
    app = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      catalog,
      maxUploadBytes: 1024 * 1024,
      parseEpub: ctx.parseEpub,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
      benchmark: { runner, machine: () => machine },
      eventStream: { heartbeatMs: 15 },
    });
  });

  afterEach(async () => {
    engine.stall = null;
    unstall?.();
    await runner.cancel();
    await app.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    ctx.cleanup();
  });

  const get = async () => (await app.inject("/api/benchmark")).json<BenchmarkView>();
  const idle = () => waitFor(async () => expect((await get()).state).toBe("idle"));

  describe("GET /api/benchmark", () => {
    it("lists a row for each voice, with no result before the first run, and says a run is due", async () => {
      const body = await get();

      expect(body).toMatchObject({
        state: "idle",
        outcome: null,
        needsRun: true,
        services: [{ id: "timed", workers: 2, maxWorkers: 2, suggestedWorkers: null }],
        machine,
      });
      expect(body.rows).toEqual([
        { language: "en", voiceId: "t-en", service: "timed", result: null },
        { language: "uk", voiceId: "t-uk", service: "timed", result: null },
      ]);
    });

    it("shows the results of a run: the rate, the factor, the throughput and the novel", async () => {
      await app.inject({ method: "POST", url: "/api/benchmark" });
      await idle();

      const body = await get();

      expect(body).toMatchObject({ outcome: "completed", needsRun: false });
      const en = body.rows[0]?.result;
      expect(en?.secondsPerKChar).toBeCloseTo(60, 3);
      expect(en?.rtf).toBeCloseTo(0.2, 3);
      expect(en?.encodeFactor).toBeNull(); // the test engine has no encoder
      expect(en?.throughput.map((p) => p.workers)).toEqual([1, 2]);
      expect(en?.outdated).toBe(false);
      // 90,000 words of 5.8 characters at 60 s per 1,000: 8.7 hours of audio; at 5 audio s/s alone, 1.7 hours.
      expect(en?.novelAudioSeconds).toBeCloseTo((90_000 * 5.8 * 60) / 1000, 0);
      expect(en?.novelConvertSeconds).toBeGreaterThan(en!.novelAudioSeconds / 5 / 2);
      expect(body.services[0]?.suggestedWorkers).toBeGreaterThanOrEqual(1);
    });

    it("marks results from another machine as outdated", async () => {
      await app.inject({ method: "POST", url: "/api/benchmark" });
      await idle();
      ctx.db.prepare("UPDATE benchmark_results SET cpu_count = 2").run();

      const body = await get();

      expect(body.rows[0]?.result?.outdated).toBe(true);
      expect(body.needsRun).toBe(true);
    });
  });

  describe("POST /api/benchmark", () => {
    it("starts a run and answers with its state", async () => {
      stall();

      const res = await app.inject({ method: "POST", url: "/api/benchmark" });

      expect(res.statusCode).toBe(202);
      expect(res.json<BenchmarkView>()).toMatchObject({ trigger: "manual" });
      expect(["waiting", "running"]).toContain(res.json<BenchmarkView>().state);
    });

    it("refuses a second run while one is going on, and the first carries on", async () => {
      stall();
      await app.inject({ method: "POST", url: "/api/benchmark" });

      const second = await app.inject({ method: "POST", url: "/api/benchmark" });

      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "conflict",
        message: "A speed test is already running.",
      });
      expect((await get()).state).not.toBe("idle");
      unstall?.();
      engine.stall = null;
      await idle();
      expect((await get()).outcome).toBe("completed");
    });

    it("answers two requests that arrive together with one run and one 409", async () => {
      stall();

      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: "/api/benchmark" }),
        app.inject({ method: "POST", url: "/api/benchmark" }),
      ]);

      expect([a.statusCode, b.statusCode].toSorted()).toEqual([202, 409]);
    });

    it("holds the pool while the test runs and gives it back", async () => {
      stall();
      await app.inject({ method: "POST", url: "/api/benchmark" });

      await waitFor(() => expect(ctx.pool.status().held).toBe(true));
      unstall?.();
      engine.stall = null;
      await idle();

      expect(ctx.pool.status().held).toBe(false);
    });
  });

  describe("DELETE /api/benchmark", () => {
    it("cancels a run: nothing is saved and no engine session stays open", async () => {
      stall();
      await app.inject({ method: "POST", url: "/api/benchmark" });
      await waitFor(async () => expect((await get()).state).toBe("running"));

      const res = await app.inject({ method: "DELETE", url: "/api/benchmark" });

      expect(res.statusCode).toBe(200);
      expect(res.json<BenchmarkView>()).toMatchObject({ state: "idle", outcome: "cancelled" });
      expect(engine.openSessions).toBe(0);
      expect((await get()).rows.every((row) => row.result === null)).toBe(true);
    });

    it("says so when no run is going on, and does not report a cancel that did not happen", async () => {
      const res = await app.inject({ method: "DELETE", url: "/api/benchmark" });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "conflict", message: "No speed test is running." });
      expect((await get()).outcome).toBeNull();
    });
  });

  describe("live events", () => {
    it("sends the progress of a run on the event stream", async () => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      let text = "";
      const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
      });
      await waitFor(() => expect(text).toContain("event: pool"));

      await app.inject({ method: "POST", url: "/api/benchmark" });
      await waitFor(() => expect(text).toMatch(/event: benchmark\n.*"outcome":"completed"/));
      req.destroy();

      expect(text).toContain('"state":"waiting"');
      expect(text).toContain('"state":"running"');
      expect(text).toContain('"held":true');
    });
  });

  it("is not served when the app has no benchmark", async () => {
    const bare = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      catalog,
      maxUploadBytes: 1024,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
    });

    expect((await bare.inject("/api/benchmark")).statusCode).toBe(404);
    await bare.close();
  });
});
