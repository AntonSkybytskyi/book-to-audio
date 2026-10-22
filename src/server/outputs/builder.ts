import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BookRepository } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import type { AppEvent, EventBus, OutputsEvent } from "../events/bus.js";
import { BuildCancelled, buildErrorMessage } from "./errors.js";
import type { OutputProducer } from "./produce.js";
import type { OutputRepository } from "./repository.js";
import { NO_OUTPUTS, toOutputsView } from "./view.js";

export interface BuilderLogger {
  info(message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface OutputBuilderDeps {
  books: Pick<BookRepository, "get" | "chapters">;
  outputs: OutputRepository;
  storage: Storage;
  producer: OutputProducer;
  bus: EventBus;
  logger?: BuilderLogger;
  /** Builds at the same time. One: encoding is heavy and must not take the CPU from the TTS workers. */
  concurrency?: number;
  /** Shortest time between progress updates (saved and published). */
  progressIntervalMs?: number;
  /** True while no new build should start (the pool is held for the speed test); queued ones wait. */
  hold?: () => boolean;
  /** Called when no build is running or waiting any more; the pool uses it to look for an idle moment. */
  onIdle?: () => void;
}

export interface RequestOptions {
  /** Build even if the files are current. */
  force?: boolean;
  /** Build again even if the last build of this audio failed. */
  retryFailed?: boolean;
}

interface Job {
  bookId: string;
  controller: AbortController;
  /** Settles when the build is over and its files are gone. */
  done: Promise<void>;
  /** The app is shutting down: leave the saved state as it is, so the build is picked up again at the next start. */
  stopping: boolean;
  workDir: string | null;
  lastProgressAt: number;
  /** A request that arrived while this job was still running, to be looked at again when it is over. */
  replay: "none" | "check" | "force";
}

const PROGRESS_INTERVAL_MS = 500;

/**
 * Builds the M4B and ZIP of finished books, one at a time and in the order they were asked for,
 * apart from the TTS workers. It listens to the event bus: a book that becomes `done` is queued,
 * and a book that stops being `done` (regenerated) has its downloads withdrawn at once.
 *
 * Generation protocol: a build notes the book's `audio_generation` when it starts and records its
 * files only if the generation is still the same when it ends (the compare is in the SQL of
 * `OutputRepository.complete`). If the audio moved on meanwhile, the files are not offered and the
 * book is built again.
 */
export class OutputBuilder {
  private readonly queue: string[] = [];
  private readonly running = new Map<string, Job>();
  /** The last view published per book, so an event is only sent when something changed. */
  private readonly published = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private stopped = true;

  constructor(private readonly deps: OutputBuilderDeps) {}

  /** Starts listening, picks up builds that were interrupted and queues finished books that have no current files. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.deps.bus.subscribe((event) => this.onEvent(event));
    const { outputs, books } = this.deps;
    for (const id of outputs.unfinished()) {
      if (books.get(id) && outputs.enqueue(id)) this.queue.push(id);
    }
    // Books converted before this existed, and builds that failed for a reason that may be gone.
    for (const id of outputs.doneBookIds()) this.request(id, { retryFailed: true });
    this.pump();
  }

  /** Cancels what is running and stops. Saved state is left, so the next start continues. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue.length = 0;
    const jobs = [...this.running.values()];
    for (const job of jobs) {
      job.stopping = true;
      job.controller.abort();
    }
    await Promise.all(jobs.map((job) => job.done));
  }

  /**
   * Asks for a build of a finished book. Does nothing for a book that is not done, that already
   * has a request or a build, or whose files are current. Returns true when a build was queued.
   */
  request(bookId: string, options: RequestOptions = {}): boolean {
    const { books, outputs } = this.deps;
    const book = books.get(bookId);
    if (!book || book.status !== "done") return false;
    const running = this.running.get(bookId);
    if (running) {
      // Building, or still wrapping up: the request is not dropped, it is looked at when this one is over.
      if (options.force) running.replay = "force";
      else if (running.replay === "none") running.replay = "check";
      return false;
    }
    if (this.queue.includes(bookId)) return false;
    const row = outputs.get(bookId);
    if (row && !options.force) {
      if (row.state === "ready" && row.builtGeneration === book.audioGeneration) return false;
      if (
        row.state === "failed" &&
        row.attemptGeneration === book.audioGeneration &&
        !options.retryFailed
      ) {
        return false;
      }
    }
    if (!outputs.enqueue(bookId)) return false;
    this.queue.push(bookId);
    this.publish(bookId);
    this.pump();
    return true;
  }

  /**
   * A file the row says was built is gone from the disk: stop offering the downloads (the view says
   * unavailable and the page stops showing dead links), and build them again.
   */
  filesMissing(bookId: string): void {
    this.deps.outputs.invalidate(bookId);
    this.publish(bookId);
    this.request(bookId, { force: true });
  }

  /** Some build is queued or running. */
  get anyBusy(): boolean {
    return this.running.size > 0 || this.queue.length > 0;
  }

  /** A build of the book is queued or running (or just finishing). */
  isBusy(bookId: string): boolean {
    return this.running.has(bookId) || this.queue.includes(bookId);
  }

  /**
   * Stops the build of a book (or drops its request) and resolves once it is over, its work files
   * are removed and nothing of it can be recorded. Used before a book's files are deleted.
   */
  async cancel(bookId: string): Promise<void> {
    const at = this.queue.indexOf(bookId);
    if (at >= 0) {
      this.queue.splice(at, 1);
      this.withdraw(bookId);
    }
    const job = this.running.get(bookId);
    if (!job) return;
    job.controller.abort();
    await job.done;
  }

  private onEvent(event: AppEvent): void {
    if (this.stopped) return;
    if (event.type === "book" || (event.type === "chapter" && event.audioVersion !== null)) {
      // After the current publish has reached everybody: an event published from inside a listener
      // would overtake the one being delivered and reach clients out of order.
      queueMicrotask(() => this.refresh(event.bookId));
    } else if (event.type === "book-deleted") {
      this.published.delete(event.bookId);
    } else if (event.type === "pool" && !event.held && this.queue.length > 0) {
      // The speed test is over: builds that waited for it can start.
      queueMicrotask(() => this.pump());
    }
  }

  /** The book or its audio changed: ask for a build if it is due, and tell clients if the downloads' state changed. */
  private refresh(bookId: string): void {
    if (this.stopped) return;
    try {
      this.request(bookId);
      this.publish(bookId);
    } catch (error) {
      this.deps.logger?.error({ err: error, bookId }, "could not update the downloads of a book");
    }
  }

  private pump(): void {
    const { concurrency = 1 } = this.deps;
    while (!this.stopped && this.running.size < concurrency && !this.deps.hold?.()) {
      const bookId = this.queue.shift();
      if (bookId === undefined) return;
      const job: Job = {
        bookId,
        controller: new AbortController(),
        done: Promise.resolve(),
        stopping: false,
        workDir: null,
        lastProgressAt: Number.NEGATIVE_INFINITY,
        replay: "none",
      };
      this.running.set(bookId, job);
      job.done = this.runSafely(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const { bookId } = job;
    // What to do once this job no longer counts as running.
    let afterwards: "none" | "again" | "withdraw" = "none";
    try {
      afterwards = await this.build(job);
    } catch (error) {
      afterwards = this.settleFailure(job, error);
    } finally {
      await this.removeWorkFiles(job);
      this.running.delete(bookId);
    }
    if (afterwards === "withdraw") this.withdraw(bookId);
    else if (afterwards === "again" && !this.request(bookId, { force: true })) {
      this.withdraw(bookId);
    }
    // A done event or a forced request that came while the job was still there is not lost.
    if (afterwards !== "again" && job.replay !== "none" && !job.stopping && !this.stopped) {
      this.request(bookId, { force: job.replay === "force" });
    }
  }

  /**
   * `run`, from which nothing escapes: whatever fails after a build is logged, the job leaves
   * `running`, and the next one is started. `job.done` therefore never rejects, so a caller that
   * waits for it (cancel, stop, a delete) cannot be taken down by it.
   */
  private async runSafely(job: Job): Promise<void> {
    try {
      await this.run(job);
    } catch (error) {
      // Whatever went wrong, the row must not stay `building` with no job behind it.
      try {
        if (!job.stopping && this.deps.outputs.fail(job.bookId, buildErrorMessage(error))) {
          this.publish(job.bookId);
        }
      } catch {
        // The next start picks up a row that is still building.
      }
      try {
        this.deps.logger?.error({ err: error, bookId: job.bookId }, "a build ended with an error");
      } catch {
        // A broken logger must not take the job down with it.
      }
    } finally {
      // Not the entry of a build that the tail of `run` already started for the same book.
      if (this.running.get(job.bookId) === job) this.running.delete(job.bookId);
      try {
        this.pump();
        if (!this.anyBusy) this.deps.onIdle?.();
      } catch (error) {
        this.deps.logger?.error({ err: error }, "could not start the next build");
      }
    }
  }

  /** One build. Returns what to do next: nothing, build again (the audio moved on), or withdraw. */
  private async build(job: Job): Promise<"none" | "again" | "withdraw"> {
    const { books, outputs, storage, producer, logger } = this.deps;
    const { bookId } = job;
    const book = books.get(bookId);
    if (!book || book.status !== "done") return "withdraw";
    const generation = book.audioGeneration;
    if (!outputs.begin(bookId, generation)) return "none";
    this.publish(bookId);

    const dir = storage.ensureOutputsDir(bookId);
    job.workDir = path.join(dir, `.${randomUUID()}`);
    await fsp.mkdir(job.workDir, { mode: 0o700 });

    const started = Date.now();
    const built = await producer.produce({
      book: { id: book.id, title: book.title, author: book.author, coverPath: book.coverPath },
      chapters: books.chapters(bookId),
      workDir: job.workDir,
      signal: job.controller.signal,
      onProgress: (fraction) => this.progress(job, fraction),
    });
    if (job.controller.signal.aborted) throw new BuildCancelled();

    // Same mode for both files (ffmpeg makes the M4B world readable, the ZIP writer does not), then to disk.
    await Promise.all([fsp.chmod(built.m4bPath, 0o600), fsp.chmod(built.zipPath, 0o600)]);
    await Promise.all([syncPath(built.m4bPath), syncPath(built.zipPath)]);
    const [m4bBytes, zipBytes] = (
      await Promise.all([fsp.stat(built.m4bPath), fsp.stat(built.zipPath)])
    ).map((stat) => stat.size) as [number, number];
    await fsp.rename(built.m4bPath, storage.outputFile(bookId, "m4b"));
    await fsp.rename(built.zipPath, storage.outputFile(bookId, "zip"));
    // The renames themselves must be on disk before the generation is recorded: after a crash,
    // a row that says ready must not point at a directory that still lists the old files.
    await syncDirectory(dir);

    if (!outputs.complete(bookId, { generation, m4bBytes, zipBytes })) {
      // The audio changed, or the book is not done any more, or it was deleted, while this ran.
      logger?.info(
        `downloads of ${bookId} were not recorded: the book changed while they were built`,
      );
      this.publish(bookId);
      return books.get(bookId)?.status === "done" ? "again" : "withdraw";
    }
    logger?.info(
      `downloads of ${bookId} are ready (${Math.round((Date.now() - started) / 1000)} s, M4B ${m4bBytes} bytes, ZIP ${zipBytes} bytes)`,
    );
    this.publish(bookId);
    return "none";
  }

  private settleFailure(job: Job, error: unknown): "none" | "withdraw" {
    const { outputs, logger } = this.deps;
    const { bookId } = job;
    if (error instanceof BuildCancelled || job.controller.signal.aborted) {
      return job.stopping ? "none" : "withdraw";
    }
    logger?.error(
      { err: error, detail: (error as { detail?: string }).detail, bookId },
      "building the downloads failed",
    );
    try {
      if (outputs.fail(bookId, buildErrorMessage(error))) this.publish(bookId);
    } catch (cause) {
      logger?.error({ err: cause, bookId }, "could not record that the downloads failed");
    }
    return "none";
  }

  private progress(job: Job, fraction: number): void {
    const { progressIntervalMs = PROGRESS_INTERVAL_MS } = this.deps;
    const now = Date.now();
    if (now - job.lastProgressAt < progressIntervalMs) return;
    job.lastProgressAt = now;
    try {
      this.deps.outputs.progress(job.bookId, fraction);
      this.publish(job.bookId);
    } catch (error) {
      this.deps.logger?.warn({ err: error, bookId: job.bookId }, "could not save build progress");
    }
  }

  /** Back to what the files on disk are, after a request or build that did not finish. */
  private withdraw(bookId: string): void {
    try {
      this.deps.outputs.withdraw(bookId);
      this.publish(bookId);
    } catch (error) {
      this.deps.logger?.error({ err: error, bookId }, "could not withdraw a build request");
    }
  }

  private async removeWorkFiles(job: Job): Promise<void> {
    if (!job.workDir) return;
    try {
      await fsp.rm(job.workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      // The next start's sweep removes it.
      this.deps.logger?.warn({ err: error, bookId: job.bookId }, "could not remove build files");
    }
  }

  /** Publishes the book's downloads state if it differs from what clients were last told. */
  private publish(bookId: string): void {
    const book = this.deps.books.get(bookId);
    if (!book) {
      this.published.delete(bookId);
      return;
    }
    const view = toOutputsView(book.status, book.audioGeneration, book.outputs);
    const key = JSON.stringify(view);
    if ((this.published.get(bookId) ?? JSON.stringify(NO_OUTPUTS)) === key) return;
    this.published.set(bookId, key);
    const event: OutputsEvent = { type: "outputs", bookId, ...view };
    this.deps.bus.publish(event);
  }
}

/** Flushes a file to disk. */
async function syncPath(file: string): Promise<void> {
  const handle = await fsp.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// What fsync on a directory says on file systems that cannot do it (some network and container mounts).
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EINVAL",
  "ENOTSUP",
  "EPERM",
  "EISDIR",
  "EBADF",
  "ENOSYS",
]);

/**
 * Flushes a directory's entries (after a rename) to disk, as far as the file system allows. Where
 * it cannot be done the files are still renamed atomically, only the order after a power cut is
 * not guaranteed, so that is no reason to fail a finished build; a real I/O error still is.
 */
export async function syncDirectory(dir: string, open: typeof fsp.open = fsp.open): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}
