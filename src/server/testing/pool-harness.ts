import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import { PoolStateStore } from "../convert/pool-state.js";
import { WorkerPool, type PoolLogger } from "../convert/pool.js";
import type { ChapterConverter, ChapterRun, ConvertedChapter } from "../convert/convert-chapter.js";
import type { AppEvent } from "../events/bus.js";
import { TtsError } from "../tts/engine.js";
import { createTestContext, type TestContext } from "./context.js";

/** Waits until `condition` holds, yielding to the event loop (not to timers) in between. */
export const until = async (condition: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await tick();
  }
};

/**
 * Lets every promise that is ready run, and every I/O callback that is already due. A check
 * that "nothing happened" after this is not racing a timer: nothing was scheduled.
 */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Chapters block here until the test lets them go, so the test controls who is busy. */
export class Gates {
  private readonly waiting = new Map<string, () => void>();
  readonly started: string[] = [];

  key = (run: ChapterRun) => `${run.task.bookId.slice(0, 4)}:${run.task.position}`;

  async hold(run: ChapterRun): Promise<void> {
    const key = this.key(run);
    this.started.push(key);
    await new Promise<void>((resolve) => {
      this.waiting.set(key, resolve);
      run.signal.addEventListener("abort", () => this.release(key), { once: true });
    });
  }

  get open(): string[] {
    return [...this.waiting.keys()];
  }

  release(key: string): void {
    const resolve = this.waiting.get(key);
    this.waiting.delete(key);
    resolve?.();
  }

  releaseAll(): void {
    for (const key of this.open) this.release(key);
  }
}

export const result = (task: { bookId: string; position: number }): ConvertedChapter => ({
  audioPath: `audio/${task.bookId}/${task.position}.webm`,
  durationSeconds: 3,
});

export interface StubConverter extends ChapterConverter {
  convert: Mock<ChapterConverter["convert"]>;
  discardChunks: Mock<ChapterConverter["discardChunks"]>;
  discardAudio: Mock<ChapterConverter["discardAudio"]>;
}

export const stubConverter = (
  convert: (run: ChapterRun) => Promise<ConvertedChapter>,
): StubConverter => ({
  convert: vi.fn<ChapterConverter["convert"]>(convert),
  discardChunks: vi.fn<ChapterConverter["discardChunks"]>(),
  discardAudio: vi.fn<ChapterConverter["discardAudio"]>(),
});

export const ok = async (run: ChapterRun) => {
  run.saveProgress(1, 2);
  return result(run.task);
};

export const failing = (message = "The engine failed.") =>
  stubConverter(async () => {
    throw new TtsError("synthesis_failed", message);
  });

export interface PoolHarness {
  readonly ctx: TestContext;
  readonly repo: BookRepository;
  readonly queue: ChapterQueue;
  readonly pool: WorkerPool | undefined;
  readonly events: AppEvent[];
  readonly gates: Gates;
  readonly logged: { level: string; context?: object; message: string }[];
  addBook(chapterCount: number, queued?: boolean): string;
  /** Builds and starts a pool with `workers` workers whose chapters are run by `converter`. */
  start(converter: ChapterConverter, workers?: number): WorkerPool;
  status(bookId: string, position: number): string | undefined;
  bookStatus(bookId: string): string | undefined;
}

/** A database, an event log and a pool factory for one test; set up and torn down around each `it`. */
export function usePoolHarness(): PoolHarness {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let pool: WorkerPool | undefined;
  let events: AppEvent[] = [];
  const gates = new Gates();
  const logged: PoolHarness["logged"] = [];
  const logger: PoolLogger = {
    info: (message) => logged.push({ level: "info", message }),
    warn: (context, message) => logged.push({ level: "warn", context, message }),
    error: (context, message) => logged.push({ level: "error", context, message }),
  };

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
    events = [];
    ctx.bus.subscribe((event) => events.push(event));
    logged.length = 0;
    gates.started.length = 0;
  });

  afterEach(async () => {
    gates.releaseAll();
    await pool?.stop();
    pool = undefined;
    ctx.cleanup();
  });

  return {
    get ctx() {
      return ctx;
    },
    get repo() {
      return repo;
    },
    get queue() {
      return queue;
    },
    get pool() {
      return pool;
    },
    get events() {
      return events;
    },
    gates,
    logged,
    addBook(chapterCount, queued = true) {
      const id = randomUUID();
      repo.insert(
        {
          id,
          title: "Book",
          author: null,
          language: "en",
          coverMime: null,
          coverPath: null,
          sourcePath: "s",
        },
        Array.from({ length: chapterCount }, (_, i) => ({
          title: `C${i + 1}`,
          text: "Hello.",
          wordCount: 1,
        })),
      );
      if (queued) repo.queue(id);
      return id;
    },
    start(converter, workers = 1) {
      ctx.settings.setWorkers(workers);
      pool = new WorkerPool({
        queue,
        converter,
        engine: ctx.engine,
        state: new PoolStateStore(ctx.db),
        settings: ctx.settings,
        bus: ctx.bus,
        logger,
        backoffMs: 2,
        progressIntervalMs: 0,
      });
      pool.start();
      return pool;
    },
    status: (id, position) => repo.chapter(id, position)?.status,
    bookStatus: (id) => repo.get(id)?.status,
  };
}
