import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, expect } from "vitest";
import { buildServer, type ServerDeps } from "../app.js";
import { BenchmarkRepository, type VoiceMeasurement } from "../benchmark/repository.js";
import { CountRepository } from "../books/count-repository.js";
import { PreparedCounter } from "../books/prepared-counter.js";
import { prepareInThread } from "../convert/chapter-text.js";
import type { BookEstimates } from "../speed/estimator.js";
import { createTestContext, type TestContext } from "./context.js";
import { multipartBody } from "./multipart.js";

export interface ChapterJson {
  position: number;
  charCount: number;
  preparedChars: number;
  estimatedSeconds: number | null;
  status: string;
}

export interface BookJson {
  id: string;
  status: string;
  language: string;
  measuring: boolean;
  estimate: BookEstimates["estimate"] | null;
  timeLeft: BookEstimates["timeLeft"];
  speed: BookEstimates["speed"] | null;
  chapters: ChapterJson[];
}

export const measurement = (voiceId: string, language: string, rate: number): VoiceMeasurement => ({
  engine: "fake",
  voiceId,
  language,
  secondsPerKChar: rate,
  rtf: 0.05,
  encodeFactor: null,
  modelLoadMs: 100,
  throughput: [
    { workers: 1, audioPerSecond: 20 },
    { workers: 2, audioPerSecond: 30 },
  ],
  sampleChars: 1000,
  sampleAudioSeconds: rate,
});

export interface EstimatesHarness {
  readonly ctx: TestContext;
  readonly app: FastifyInstance;
  readonly counter: PreparedCounter;
  /** Rebuilds the server with other dependencies (a slow text preparer, say). */
  rebuild(overrides: Partial<ServerDeps>): void;
  /** Stores a benchmark for the English and Ukrainian test voices (60 and 80 s per 1,000 characters). */
  benchmarked(): void;
  /** Uploads a book and, unless told not to, waits until its text has been counted. */
  upload(book: Buffer, options?: { settle?: boolean }): Promise<BookJson>;
  read(id: string): Promise<BookJson>;
  convert(id: string): Promise<LightMyRequestResponse>;
  estimate(id: string, language: string): Promise<LightMyRequestResponse>;
  library(): Promise<BookJson[]>;
  setChapters(id: string, statuses: [string, number][]): void;
}

/** A server over a test database whose engine has English and Ukrainian voices, one worker, and a counter you can wait for. */
export function useEstimatesHarness(): EstimatesHarness {
  let ctx: TestContext;
  let app: FastifyInstance;
  let counter: PreparedCounter;

  const build = (overrides: Partial<ServerDeps> = {}) => {
    counter = new PreparedCounter({
      repo: new CountRepository(ctx.db),
      prepare: overrides.prepareText ?? prepareInThread,
      maxChars: ctx.engine.maxInputChars,
      bus: ctx.bus,
    });
    app = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      engine: ctx.engine,
      maxUploadBytes: 5 * 1024 * 1024,
      parseEpub: ctx.parseEpub,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
      counter,
      ...overrides,
    });
  };

  beforeEach(() => {
    ctx = createTestContext({
      voices: [
        { id: "fake-en", language: "en", name: "En", sampleRate: 22_050 },
        { id: "fake-uk", language: "uk", name: "Uk", sampleRate: 22_050 },
      ],
    });
    build();
    ctx.settings.setWorkers(1);
  });

  afterEach(async () => {
    await counter.stop();
    await app.close();
    ctx.cleanup();
  });

  const read = async (id: string) => (await app.inject(`/api/books/${id}`)).json<BookJson>();

  return {
    get ctx() {
      return ctx;
    },
    get app() {
      return app;
    },
    get counter() {
      return counter;
    },
    rebuild(overrides) {
      void app.close();
      build(overrides);
    },
    benchmarked() {
      new BenchmarkRepository(ctx.db).save(
        [measurement("fake-en", "en", 60), measurement("fake-uk", "uk", 80)],
        { cpuCount: 4, cpuModel: "cpu" },
        3,
        "2026-01-01T00:00:00Z",
      );
    },
    async upload(book, { settle = true } = {}) {
      const res = await app.inject({
        method: "POST",
        url: "/api/books",
        ...multipartBody([{ filename: "b.epub", data: book }]),
      });
      expect(res.statusCode).toBe(201);
      const created = res.json<BookJson>();
      if (!settle) return created;
      await counter.whenIdle();
      return read(created.id);
    },
    read,
    convert: (id) => app.inject({ method: "POST", url: `/api/books/${id}/convert` }),
    estimate: (id, language) => app.inject(`/api/books/${id}/estimate?language=${language}`),
    async library() {
      return (await app.inject("/api/books")).json<{ books: BookJson[] }>().books;
    },
    setChapters(id, statuses) {
      const update = ctx.db.prepare(
        "UPDATE chapters SET status = ?, progress = ? WHERE book_id = ? AND position = ?",
      );
      statuses.forEach(([status, progress], i) => update.run(status, progress, id, i + 1));
    },
  };
}
