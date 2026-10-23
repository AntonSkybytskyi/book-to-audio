import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import { OutputBuilder, type BuilderLogger, type OutputBuilderDeps } from "../outputs/builder.js";
import type { BuiltOutputs, OutputJob, OutputProducer } from "../outputs/produce.js";
import { OutputRepository } from "../outputs/repository.js";
import type { AppEvent } from "../events/bus.js";
import { BuildCancelled } from "../outputs/errors.js";
import { createTestContext, type TestContext } from "./context.js";
import { until } from "./pool-harness.js";
import { LANGUAGES } from "../books/languages.js";

/** A producer a test controls: every build waits at a gate until the test lets it go or makes it fail. */
export class ScriptedProducer implements OutputProducer {
  /** The book ids of the builds that started, in order. */
  readonly started: string[] = [];
  readonly jobs: OutputJob[] = [];
  /** Builds do not wait for a gate when this is false. */
  hold = true;
  private readonly open = new Map<string, { go: () => void; fail: (error: unknown) => void }>();
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, unknown>();

  /** Lets the build of `bookId` finish (also lets the next one finish if it has not started yet). */
  release(bookId: string): void {
    this.pending.add(bookId);
    this.open.get(bookId)?.go();
  }

  /** Makes the build of `bookId` fail with `error`. */
  failWith(bookId: string, error: unknown): void {
    this.failures.set(bookId, error);
    this.release(bookId);
  }

  isRunning(bookId: string): boolean {
    return this.open.has(bookId);
  }

  async produce(job: OutputJob): Promise<BuiltOutputs> {
    const { id } = job.book;
    this.started.push(id);
    this.jobs.push(job);
    job.onProgress(0.25);
    if (this.hold && !this.pending.has(id)) {
      await new Promise<void>((resolve, reject) => {
        this.open.set(id, { go: resolve, fail: reject });
        job.signal.addEventListener("abort", () => reject(new BuildCancelled()), { once: true });
      }).finally(() => this.open.delete(id));
    }
    this.pending.delete(id);
    const failure = this.failures.get(id);
    this.failures.delete(id);
    if (failure) throw failure;
    if (job.signal.aborted) throw new BuildCancelled();
    const m4bPath = path.join(job.workDir, "book.m4b");
    const zipPath = path.join(job.workDir, "book.zip");
    fs.writeFileSync(m4bPath, `m4b #${this.started.length}`);
    fs.writeFileSync(zipPath, `zip #${this.started.length}`);
    return { m4bPath, zipPath };
  }
}

export interface OutputsHarness {
  readonly ctx: TestContext;
  readonly repo: BookRepository;
  readonly queue: ChapterQueue;
  readonly outputs: OutputRepository;
  readonly producer: ScriptedProducer;
  readonly builder: OutputBuilder;
  readonly events: AppEvent[];
  readonly logged: { level: string; message: string }[];
  /** A book with `chapters` finished chapters (with audio files). It is `done`; no event was published. */
  addDoneBook(chapters?: number): string;
  /** Makes a new builder over the same database, as after a restart. */
  restart(deps?: Partial<OutputBuilderDeps>): OutputBuilder;
  /** Announces that the book is done, the way the pool does. */
  announceDone(bookId: string): void;
  /** Writes one of the chapters of the book again, which is what bumps the audio generation. */
  rewriteChapter(bookId: string, position: number): void;
  generation(bookId: string): number;
  state(bookId: string): string | undefined;
  files(bookId: string): string[];
}

/** A database, an event log and an output builder over a producer the test controls. */
export function useOutputsHarness(options: Partial<OutputBuilderDeps> = {}): OutputsHarness {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let outputs: OutputRepository;
  let producer: ScriptedProducer;
  let builder: OutputBuilder;
  let events: AppEvent[] = [];
  const logged: OutputsHarness["logged"] = [];
  const logger: BuilderLogger = {
    info: (message) => logged.push({ level: "info", message }),
    warn: (_context, message) => logged.push({ level: "warn", message }),
    error: (_context, message) => logged.push({ level: "error", message }),
  };

  const make = (extra: Partial<OutputBuilderDeps> = {}) =>
    new OutputBuilder({
      books: repo,
      outputs,
      storage: ctx.storage,
      producer,
      bus: ctx.bus,
      logger,
      progressIntervalMs: 0,
      ...options,
      ...extra,
    });

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
    outputs = new OutputRepository(ctx.db);
    producer = new ScriptedProducer();
    events = [];
    logged.length = 0;
    ctx.bus.subscribe((event) => events.push(event));
    builder = make();
  });

  afterEach(async () => {
    producer.hold = false;
    await builder.stop();
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
    get outputs() {
      return outputs;
    },
    get producer() {
      return producer;
    },
    get builder() {
      return builder;
    },
    get events() {
      return events;
    },
    logged,
    addDoneBook(chapterCount = 2) {
      const id = randomUUID();
      repo.insert(
        {
          id,
          title: "Book",
          author: "Author",
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
      ctx.storage.ensureBookDir(id);
      ctx.storage.ensureAudioDir(id);
      repo.queue(id);
      for (let i = 0; i < chapterCount; i++) {
        const task = queue.claimNext(LANGUAGES);
        if (!task) throw new Error("expected a chapter");
        const rel = ctx.storage.audioRelPath(id, task.position);
        fs.writeFileSync(ctx.storage.resolve(rel), `audio ${task.position}`);
        queue.markDone(task, rel, 5);
      }
      queue.refreshBookStatus(id);
      return id;
    },
    restart(deps = {}) {
      builder = make(deps);
      return builder;
    },
    announceDone(bookId) {
      const counts = queue.bookCounts(bookId);
      if (counts) ctx.bus.publish({ type: "book", bookId, ...counts });
    },
    rewriteChapter(bookId, position) {
      ctx.db
        .prepare(
          "UPDATE chapters SET audio_version = audio_version + 1 WHERE book_id = ? AND position = ?",
        )
        .run(bookId, position);
      ctx.db
        .prepare("UPDATE books SET audio_generation = audio_generation + 1 WHERE id = ?")
        .run(bookId);
    },
    generation: (bookId) => repo.audioGeneration(bookId),
    state: (bookId) => outputs.get(bookId)?.state,
    files(bookId) {
      const dir = ctx.storage.outputsDir(bookId);
      return fs.existsSync(dir) ? fs.readdirSync(dir).toSorted() : [];
    },
  };
}

export const settled = (condition: () => boolean) => until(condition, 5000);
