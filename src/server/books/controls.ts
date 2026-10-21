import type { PoolControl } from "../convert/pool.js";
import type { EventBus } from "../events/bus.js";
import { KeyedLock } from "./keyed-lock.js";
import type { ChapterQueue } from "./queue.js";
import type { BookRepository } from "./repository.js";
import type { Storage } from "./storage.js";
import type { BookTransitions } from "./transitions.js";

/** A request the book's current state does not allow, or that names something that is gone. */
export class ControlError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

const missingBook = () => new ControlError(404, "not_found", "There is no book with this id.");

export interface BookControlsDeps {
  repo: BookRepository;
  queue: ChapterQueue;
  transitions: BookTransitions;
  storage: Storage;
  bus: EventBus;
  pool: Pick<PoolControl, "notify" | "abortChapter" | "abortBook">;
  /** How long to wait for workers to stop before giving up. */
  abortTimeoutMs?: number;
  logger?: { warn(context: object, message: string): void };
}

const ABORT_TIMEOUT_MS = 30_000;

/** Resolves true when `work` settled in time, false when it did not (it keeps running). */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return (await Promise.race([work.then(() => true), late])) as boolean;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the owner does to a book once it is queued: pause, resume, regenerate, delete.
 * Every operation on a book runs under that book's lock. Stopping workers is always awaited
 * before files are touched, so a worker is never writing into a folder that is being emptied.
 * Whatever goes wrong after chapters were taken out of the queue, they are put back.
 */
export class BookControls {
  private readonly lock = new KeyedLock();

  constructor(private readonly deps: BookControlsDeps) {}

  /** `converting` to `paused`: running chapters finish, none is started. */
  pause(bookId: string): Promise<void> {
    return this.lock.run(bookId, async () => {
      this.requireBook(bookId);
      if (!this.deps.transitions.pause(bookId)) {
        throw new ControlError(409, "conflict", "Only a book that is converting can be paused.");
      }
      this.publishBook(bookId);
    });
  }

  /** `paused` to `converting`, in its old place in the queue. */
  resume(bookId: string): Promise<void> {
    return this.lock.run(bookId, async () => {
      this.requireBook(bookId);
      if (this.deps.transitions.resume(bookId) === null) {
        throw new ControlError(409, "conflict", "This book is not paused.");
      }
      this.publishBook(bookId);
      this.deps.pool.notify();
    });
  }

  /**
   * Synthesizes one chapter again. A failed chapter continues from its saved chunks;
   * a finished or running one starts from the beginning (a running one is stopped first).
   * One that is already waiting is left as it is. The old audio stays playable.
   */
  regenerateChapter(bookId: string, position: number): Promise<void> {
    return this.lock.run(bookId, async () => {
      const { repo, transitions, pool } = this.deps;
      const book = this.requireBook(bookId);
      const chapter = repo.chapter(bookId, position);
      if (!chapter) throw new ControlError(404, "not_found", "There is no such chapter.");
      if (book.status === "ready" || chapter.status === "pending") {
        throw new ControlError(409, "conflict", "Convert the book before regenerating a chapter.");
      }
      if (chapter.status === "queued") return;

      const fresh = chapter.status !== "failed";
      const restartChapter = () => {
        if (fresh) this.deps.storage.removeParts(bookId, position);
        this.restart(bookId, { position, fresh });
      };
      if (chapter.status !== "generating") {
        restartChapter();
        return;
      }

      // The worker's own thread of control runs `restartChapter` the moment the chapter is
      // settled, before the worker can claim another one: the chapter is the next to run.
      let done = false;
      let failure: unknown = null;
      // Set when this request gives up: a worker that settles later must not run it then, outside
      // the lock, on a chapter that is queued or running again by that time.
      let abandoned = false;
      const afterSettle = () => {
        if (abandoned) return;
        try {
          restartChapter();
          done = true;
        } catch (error) {
          failure = error;
        }
      };
      const ids = transitions.suspend(bookId, position);
      try {
        const stopped = settledWithin(
          Promise.all(ids.map((id) => pool.abortChapter(id, afterSettle))),
          this.abortTimeoutMs,
        );
        if (!(await stopped)) throw new Error("The worker did not stop in time.");
        if (!done && failure === null) afterSettle(); // it had already finished
        if (failure !== null) throw failure;
      } catch (error) {
        // Never leave the chapter held with no worker: put it back in the queue as it is.
        abandoned = true;
        this.requeueAfterFailure(bookId, { position, ids });
        throw error;
      }
    });
  }

  /**
   * Synthesizes every chapter again from the beginning; running ones are stopped first.
   * When every chapter is already waiting with nothing done yet, there is nothing to redo.
   */
  regenerateBook(bookId: string): Promise<void> {
    return this.lock.run(bookId, async () => {
      const { repo, transitions, storage, pool } = this.deps;
      const book = this.requireBook(bookId);
      if (book.status === "ready") {
        throw new ControlError(409, "conflict", "Convert the book before regenerating it.");
      }
      const chapters = repo.chapters(bookId);
      if (chapters.every((c) => c.status === "queued" && c.chunksDone === 0)) return;

      const held = transitions.suspend(bookId);
      try {
        if (!(await settledWithin(pool.abortBook(bookId), this.abortTimeoutMs))) {
          throw new Error("The workers did not stop in time.");
        }
        for (const chapter of chapters) storage.removeParts(bookId, chapter.position);
        this.restart(bookId, { fresh: true });
      } catch (error) {
        this.requeueAfterFailure(bookId, { ids: held });
        throw error;
      }
    });
  }

  /**
   * Removes the book, then stops its workers, then removes its files. The rows go first, so
   * no worker can claim another chapter and every update from a running one is dropped. A
   * worker that does not stop in time is left behind (it can no longer write anywhere that
   * matters), and the files that remain are removed by the next start's sweep.
   * Returns the error if the files could not all be removed.
   */
  delete(bookId: string): Promise<{ filesError: unknown }> {
    return this.lock.run(bookId, async () => {
      const { transitions, storage, pool, bus, logger } = this.deps;
      if (!transitions.remove(bookId)) throw missingBook();
      if (!(await settledWithin(pool.abortBook(bookId), this.abortTimeoutMs))) {
        logger?.warn({ bookId }, "workers did not stop in time; deleting the files anyway");
      }
      let filesError: unknown = null;
      try {
        storage.removeBookFiles(bookId);
      } catch (error) {
        filesError = error;
      }
      bus.publish({ type: "book-deleted", bookId });
      return { filesError };
    });
  }

  private get abortTimeoutMs() {
    return this.deps.abortTimeoutMs ?? ABORT_TIMEOUT_MS;
  }

  private requireBook(bookId: string) {
    const book = this.deps.repo.get(bookId);
    if (!book) throw missingBook();
    return book;
  }

  /**
   * Puts the chapters that were held back in the queue (keeping their chunks) after something
   * failed. Only those: finished and failed chapters of the book are not touched.
   */
  private requeueAfterFailure(
    bookId: string,
    scope: { position?: number; ids: readonly number[] },
  ): void {
    try {
      this.restart(bookId, { ...scope, fresh: false });
    } catch (error) {
      this.deps.logger?.warn({ err: error, bookId }, "could not put chapters back in the queue");
    }
  }

  private restart(
    bookId: string,
    scope: { position?: number; fresh: boolean; ids?: readonly number[] },
  ): void {
    const { repo, transitions, bus, pool } = this.deps;
    const restarted = transitions.restart(bookId, scope);
    if (!restarted) throw missingBook();
    for (const position of restarted.positions) {
      const chapter = repo.chapter(bookId, position);
      if (!chapter) continue;
      bus.publish({
        type: "chapter",
        bookId,
        position,
        status: chapter.status,
        progress: chapter.progress,
        error: null,
        durationSeconds: null,
        chunkCount: chapter.chunkCount,
        chunksDone: chapter.chunksDone,
        audioVersion: null,
        regenError: null,
      });
    }
    this.publishBook(bookId);
    pool.notify();
  }

  private publishBook(bookId: string): void {
    const counts = this.deps.queue.bookCounts(bookId);
    if (counts) this.deps.bus.publish({ type: "book", bookId, ...counts });
  }
}
