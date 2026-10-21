import type { ClaimedChapter } from "../books/queue.js";
import { DiskFullError, GENERIC_CHAPTER_ERROR, UserFacingError } from "../errors.js";
import { ProgressPublisher } from "../events/throttle.js";
import { TtsError } from "../tts/engine.js";
import type { ConvertedChapter } from "./convert-chapter.js";
import { chapterEvent, type Counts } from "./pool-events.js";
import type { PoolControl, PoolDeps, PoolStatus } from "./pool-types.js";
import { sleep } from "./retry.js";
import { SessionHolder } from "./sessions.js";

interface Worker {
  index: number;
  /** Set when the worker count dropped below its index: it stops after its current chapter. */
  retiring: boolean;
  sessions: SessionHolder;
  current: {
    task: ClaimedChapter;
    controller: AbortController;
    /** Run once the chapter has been settled, before this worker looks for its next one. */
    afterSettle: (() => void)[];
  } | null;
  /** Settles when the chapter being converted has been fully dealt with, result saved or dropped. */
  processing: Promise<void> | null;
  loop: Promise<void>;
}

/**
 * N workers taking chapters from one global queue, earliest book first. Each
 * worker owns an engine session. Three chapters failing in a row, or a nearly
 * full disk, pause the pool.
 */
export type { PoolControl, PoolDeps, PoolLogger, PoolStatus } from "./pool-types.js";

export class WorkerPool implements PoolControl {
  private readonly workers = new Map<number, Worker>();
  private readonly wakers = new Set<() => void>();
  private readonly closing = new Set<Promise<void>>();
  private readonly events: ProgressPublisher;
  private target: number;
  private running = false;
  private paused = false;
  private shutdown = new AbortController();

  constructor(private readonly deps: PoolDeps) {
    this.target = deps.settings.workers();
    this.events = new ProgressPublisher(deps.bus, deps.progressIntervalMs);
  }

  /** Re-queues interrupted chapters (their chunks are kept) and starts the workers. */
  start(): void {
    if (this.running) return;
    const { queue, state, logger } = this.deps;
    const reset = queue.resetInterrupted();
    if (reset > 0) logger?.info(`re-queued ${reset} interrupted chapter(s)`);
    queue.refreshAllActive();
    this.paused = state.get().state === "paused";
    if (this.paused) logger?.info("the pool is paused; resume it from the app");
    this.shutdown = new AbortController();
    this.running = true;
    this.target = this.deps.settings.workers();
    this.reconcile();
    this.publishPool();
  }

  /** Cancels running chapters, which go back to the queue, and waits until every worker is gone. */
  async stop(): Promise<void> {
    this.running = false;
    this.shutdown.abort();
    const loops = [...this.workers.values()].map((worker) => worker.loop);
    for (const worker of this.workers.values()) worker.current?.controller.abort();
    this.wake();
    await Promise.all(loops);
    // Workers that retired earlier may still be stopping their engine process.
    await Promise.all(this.closing);
    this.workers.clear();
    this.events.stop();
  }

  notify(): void {
    this.wake();
  }

  status(): PoolStatus {
    const { state, error, cause } = this.deps.state.get();
    const activeWorkers = [...this.workers.values()].filter((worker) => worker.current).length;
    return { state, error, cause, workers: this.target, activeWorkers };
  }

  resume(): PoolStatus {
    if (this.deps.state.resume()) {
      this.paused = false;
      this.deps.logger?.info("the pool was resumed");
      this.wake();
    }
    this.publishPool();
    return this.status();
  }

  setWorkers(count: number): PoolStatus {
    this.target = count;
    if (this.running) this.reconcile();
    this.publishPool();
    return this.status();
  }

  /**
   * Cancels the attempt at a chapter, if one is running, and resolves once the worker has
   * dealt with it. The chapter goes back to the queue unless its row was changed first
   * (deleted, or set to something else): then the cancelled attempt's result is dropped.
   * `afterSettle` runs, if an attempt was running, in the same synchronous step that ends it:
   * no worker can claim a chapter in between, so what it queues is what the next claim sees.
   */
  async abortChapter(id: number, afterSettle?: () => void): Promise<void> {
    await this.abortWhere((task) => task.id === id, afterSettle);
  }

  /** `abortChapter` for every running chapter of a book. */
  async abortBook(bookId: string): Promise<void> {
    await this.abortWhere((task) => task.bookId === bookId);
  }

  private async abortWhere(
    matches: (task: ClaimedChapter) => boolean,
    afterSettle?: () => void,
  ): Promise<void> {
    const settled: Promise<void>[] = [];
    for (const { current, processing } of this.workers.values()) {
      if (!current || !matches(current.task)) continue;
      if (afterSettle) current.afterSettle.push(afterSettle);
      current.controller.abort();
      if (processing) settled.push(processing);
    }
    await Promise.all(settled);
  }

  private reconcile(): void {
    for (let index = 0; index < this.target; index++) {
      const worker = this.workers.get(index);
      if (worker) worker.retiring = false;
      else this.spawn(index);
    }
    for (const worker of this.workers.values()) {
      if (worker.index >= this.target) worker.retiring = true;
    }
    this.wake();
  }

  private spawn(index: number): void {
    const worker: Worker = {
      index,
      retiring: false,
      sessions: new SessionHolder(this.deps.engine, { idleMs: this.deps.sessionIdleMs }),
      current: null,
      processing: null,
      loop: Promise.resolve(),
    };
    this.workers.set(index, worker);
    worker.loop = this.work(worker);
  }

  private wake(): void {
    const wakers = [...this.wakers];
    this.wakers.clear();
    for (const wake of wakers) wake();
  }

  private async work(worker: Worker): Promise<void> {
    const { queue, logger, backoffMs = 1000 } = this.deps;
    while (this.running && !worker.retiring) {
      try {
        const task = this.paused ? null : queue.claimNext();
        if (task) {
          worker.processing = this.process(worker, task);
          await worker.processing;
          worker.processing = null;
          continue;
        }
        // Nothing can be queued between claimNext and here: both run in one tick.
        await new Promise<void>((resolve) => this.wakers.add(resolve));
      } catch (error) {
        // A database failure must not end the worker; wait a moment so it cannot spin.
        logger?.error({ err: error }, "worker could not take or record a chapter");
        await sleep(backoffMs, this.shutdown.signal);
      }
    }
    // Leave the map in the same tick as the check above, so a count that rises again spawns a new one.
    if (this.workers.get(worker.index) === worker) this.workers.delete(worker.index);
    const closing = worker.sessions.close().catch((error: unknown) => {
      logger?.error({ err: error }, "could not stop an engine process");
    });
    this.closing.add(closing);
    await closing;
    this.closing.delete(closing);
    this.publishPool();
  }

  private async process(worker: Worker, task: ClaimedChapter): Promise<void> {
    const { queue, converter, logger } = this.deps;
    const controller = new AbortController();
    const afterSettle: (() => void)[] = [];
    worker.current = { task, controller, afterSettle };
    const counts = { done: task.chunksDone, total: task.chunkCount };
    this.events.publish(chapterEvent(task, "generating", counts));
    this.publishPool();

    // Converting and saving the outcome fail for different reasons, so they are
    // kept apart: a save that throws must not be mistaken for a bad chapter.
    let converted: ConvertedChapter | null = null;
    let failure: unknown = null;
    try {
      converted = await converter.convert({
        task,
        sessions: worker.sessions,
        signal: controller.signal,
        saveProgress: (done, total) => {
          if (!queue.recordChunks(task, done, total)) {
            controller.abort(); // Stale: the chapter was re-queued or taken by another worker.
            return false;
          }
          // The first save of an attempt repeats what the claim already announced.
          const changed = done !== counts.done || total !== counts.total;
          counts.done = done;
          counts.total = total;
          if (changed) this.events.progress(chapterEvent(task, "generating", counts));
          return true;
        },
      });
    } catch (error) {
      failure = error;
    }
    worker.current = null;

    try {
      this.settle(task, controller.signal, converted, failure, counts);
    } catch (error) {
      logger?.error(
        { err: error, bookId: task.bookId, chapter: task.position },
        "could not save the result of a chapter",
      );
      this.failBestEffort(task, counts);
    }
    this.events.forget(task.bookId, task.position);
    for (const hook of afterSettle) {
      try {
        hook();
      } catch (error) {
        logger?.error({ err: error, bookId: task.bookId }, "an action after a chapter failed");
      }
    }

    try {
      queue.refreshBookStatus(task.bookId);
      const book = queue.bookCounts(task.bookId);
      if (book) this.events.publish({ type: "book", bookId: task.bookId, ...book });
    } catch (error) {
      logger?.error({ err: error, bookId: task.bookId }, "could not update the book status");
    }
    this.publishPool();
  }

  private settle(
    task: ClaimedChapter,
    signal: AbortSignal,
    converted: ConvertedChapter | null,
    failure: unknown,
    counts: Counts,
  ): void {
    const { queue, converter, state, logger } = this.deps;
    const where = { bookId: task.bookId, chapter: task.position };

    if (converted) {
      if (queue.markDone(task, converted.audioPath, converted.durationSeconds)) {
        converter.discardChunks(task);
        state.recordSuccess();
        this.events.publish({
          ...chapterEvent(task, "done", counts),
          progress: 1,
          durationSeconds: converted.durationSeconds,
          audioVersion: queue.audioVersion(task.id),
        });
      } else {
        // Another attempt owns the chapter now; its file may share this path. Note that a worker
        // whose claim went stale while it was joining can already have renamed its file over the
        // chapter's file (the join does that itself), without a new audio_version or
        // audio_generation: those only count writes that `markDone` recorded.
        logger?.warn(where, "dropped the result of a chapter that was replaced");
        if (!queue.audioInUse(converted.audioPath)) converter.discardAudio(converted.audioPath);
      }
      return;
    }

    const cancelled = signal.aborted || (failure instanceof TtsError && failure.code === "aborted");
    if (cancelled) {
      // Stopping, or replaced by a newer claim (then nothing changes). Chunks stay for the next attempt.
      this.requeue(task, counts);
      return;
    }

    if (failure instanceof DiskFullError) {
      // Not the chapter's fault: keep it and its chunks, and stop taking work until there is room.
      logger?.error({ err: failure, detail: failure.detail, ...where }, "the disk is nearly full");
      this.requeue(task, counts);
      if (state.pause("disk", failure.message)) this.paused = true;
      return;
    }

    logger?.error(
      { err: failure, detail: (failure as UserFacingError | null)?.detail, ...where },
      "chapter failed",
    );
    const message = failure instanceof UserFacingError ? failure.message : GENERIC_CHAPTER_ERROR;
    // The finished chunks stay, so running the chapter again can continue from them.
    if (!queue.markFailed(task, message)) return;
    this.publishFailure(task, counts, message);
    // Text that cannot be read says nothing about the engine, so it does not count towards
    // pausing the pool. Everything else (a crash, a timeout, a missing binary) does.
    if (failure instanceof TtsError && failure.code === "bad_input") return;
    if (state.recordFailure(message)) {
      this.paused = true;
      logger?.error({ error: message }, "three chapters failed in a row, the pool is paused");
    }
  }

  private requeue(task: ClaimedChapter, counts: Counts): void {
    if (!this.deps.queue.requeue(task)) return;
    this.events.publish(chapterEvent(task, "queued", counts));
    this.wake(); // Another worker may be idle.
  }

  /**
   * A chapter that has audio was being regenerated: it is `done` again with that audio and
   * keeps the message as a note, and its chunks are no longer needed. Any other becomes `failed`.
   */
  private publishFailure(task: ClaimedChapter, counts: Counts, error: string): void {
    if (!this.deps.queue.hasAudio(task.id)) {
      this.events.publish({ ...chapterEvent(task, "failed", counts), error });
      return;
    }
    this.events.publish({
      ...chapterEvent(task, "done", { done: 0, total: 0 }),
      progress: 1,
      regenError: error,
    });
    // After the event and the failure count: leftover chunks are only waste, and a failure
    // to remove them must not hide what happened. The startup sweep removes them.
    try {
      this.deps.converter.discardChunks(task);
    } catch (cause) {
      this.deps.logger?.warn(
        { err: cause, bookId: task.bookId, chapter: task.position },
        "could not remove the chunks of a failed regeneration",
      );
    }
  }

  /** Last resort when saving a result failed, so the chapter is not left `generating`. */
  private failBestEffort(task: ClaimedChapter, counts: Counts): void {
    const message = "The result of this chapter could not be saved.";
    try {
      if (this.deps.queue.markFailed(task, message)) this.publishFailure(task, counts, message);
    } catch (error) {
      // The next start re-queues anything still generating.
      this.deps.logger?.error({ err: error, bookId: task.bookId }, "chapter left generating");
    }
  }

  private publishPool(): void {
    this.events.publish({ type: "pool", ...this.status() });
  }
}
