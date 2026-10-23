import type { ClaimedChapter } from "../books/queue.js";
import { DiskFullError, GENERIC_CHAPTER_ERROR, UserFacingError } from "../errors.js";
import { ProgressPublisher } from "../events/throttle.js";
import { TtsError, type TtsEngine } from "../tts/engine.js";
import type { ConvertedChapter } from "./convert-chapter.js";
import { ConcurrencyMeter } from "./concurrency.js";
import { chapterEvent, type Counts } from "./pool-events.js";
import { failBestEffort, publishFailure, recordTiming } from "./pool-outcome.js";
import { PoolGate, type Release } from "./pool-gate.js";
import type { PoolControl, PoolDeps, PoolStatus } from "./pool-types.js";
import { sleep } from "./retry.js";
import { SessionHolder } from "./sessions.js";
import { workerTarget } from "./worker-target.js";

/** The workers of one TTS service. */
interface Group {
  engine: TtsEngine;
  workers: Map<number, Worker>;
  target: number;
  /** Three of its chapters failed in a row: it takes no work until resumed. */
  paused: boolean;
  /** Busy workers of this service, for the speed estimates: services do not slow each other down. */
  meter: ConcurrencyMeter;
}

interface Worker {
  group: Group;
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
 * Workers taking chapters from one global queue, earliest book first, in a group per TTS service:
 * as many as the service handles at once (or the settings say), each taking only chapters whose
 * language is read by a voice on its service. Each worker owns an engine session. Three chapters
 * of a service failing in a row pause that service; a nearly full disk pauses the whole pool.
 */
export type { PoolControl, PoolDeps, PoolLogger, PoolStatus } from "./pool-types.js";

export class WorkerPool implements PoolControl {
  private readonly groups = new Map<string, Group>();
  private readonly wakers = new Set<() => void>();
  private readonly closing = new Set<Promise<void>>();
  private readonly events: ProgressPublisher;
  private running = false;
  /** The disk is nearly full: no service takes work. */
  private paused = false;
  private shutdown = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  /** Counts the times the pool was held, released or resumed: a chapter that saw one is no measure of speed. */
  private disturbances = 0;
  private readonly gate = new PoolGate(() => {
    this.disturbances++;
    this.wake();
    this.publishPool();
  });

  constructor(private readonly deps: PoolDeps) {
    this.events = new ProgressPublisher(deps.bus, deps.progressIntervalMs);
    this.now = deps.now ?? (() => performance.now());
    for (const engine of deps.catalog.engines()) {
      this.groups.set(engine.id, {
        engine,
        workers: new Map(),
        target: 0,
        paused: false,
        meter: new ConcurrencyMeter(this.now),
      });
    }
    this.countWorkers();
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
    for (const group of this.groups.values()) {
      group.paused = state.service(group.engine.id).state === "paused";
      if (group.paused) logger?.info(`"${group.engine.id}" is paused; resume it from the app`);
    }
    this.shutdown = new AbortController();
    this.running = true;
    // A service that comes back, goes away or reports another limit gets its workers counted again.
    this.unsubscribe = this.deps.catalog.onChange(() => {
      this.refreshWorkers();
      this.wake(); // A voice that appeared may make queued chapters claimable.
    });
    this.countWorkers();
    for (const group of this.groups.values()) this.reconcile(group);
    this.publishPool();
  }

  /** Cancels running chapters, which go back to the queue, and waits until every worker is gone. */
  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.shutdown.abort();
    const workers = this.workers();
    for (const worker of workers) worker.current?.controller.abort();
    this.wake();
    await Promise.all(workers.map((worker) => worker.loop));
    // Workers that retired earlier may still be stopping their engine process.
    await Promise.all(this.closing);
    for (const group of this.groups.values()) group.workers.clear();
    this.events.stop();
  }

  notify(): void {
    this.wake();
  }

  status(): PoolStatus {
    const { state, error, cause } = this.deps.state.get();
    const services = [...this.groups.values()].map(({ engine, workers, target }) => {
      const service = this.deps.state.service(engine.id);
      return {
        id: engine.id,
        state: service.state,
        error: service.error,
        reachable: engine.reachable,
        workers: target,
        reportedWorkers: engine.ready ? engine.concurrency : 0,
        activeWorkers: [...workers.values()].filter((worker) => worker.current).length,
      };
    });
    return {
      state,
      error,
      cause,
      workers: services.reduce((sum, service) => sum + service.workers, 0),
      activeWorkers: services.reduce((sum, service) => sum + service.activeWorkers, 0),
      held: this.gate.held,
      services,
    };
  }

  hold(signal?: AbortSignal): Promise<Release> {
    return this.gate.hold(() => this.inFlight(), signal);
  }

  holdWhenIdle(signal?: AbortSignal): Promise<Release> {
    return this.gate.holdWhenIdle(() => this.idle(), signal);
  }

  private workers(): Worker[] {
    return [...this.groups.values()].flatMap((group) => [...group.workers.values()]);
  }

  private inFlight(): Promise<void>[] {
    return this.workers().flatMap((worker) => (worker.processing ? [worker.processing] : []));
  }

  /** Looks again for an idle moment, for a waiter that was held up by something outside the pool. */
  recheckIdle(): void {
    this.gate.offerIdle(() => this.idle());
  }

  /**
   * No chapter is being read and none could be taken (a stopped pool has no workers at all).
   * Chapters whose language has no voice, or whose service has no workers, cannot be taken.
   */
  private idle(): boolean {
    if (this.inFlight().length > 0 || this.deps.busyElsewhere?.()) return false;
    if (!this.running || this.paused) return true;
    const languages = [...this.groups.values()]
      .filter((group) => group.target > 0 && !group.paused)
      .flatMap((group) => this.deps.catalog.languagesOn(group.engine.id));
    return !this.deps.queue.hasClaimable(languages);
  }

  resume(service?: string): PoolStatus {
    if (this.deps.state.resume(service)) {
      if (service === undefined) this.paused = false;
      for (const group of this.groups.values()) {
        if (service === undefined || group.engine.id === service) group.paused = false;
      }
      this.disturbances++;
      this.deps.logger?.info(
        service === undefined ? "the pool was resumed" : `"${service}" was resumed`,
      );
      this.wake();
    }
    this.publishPool();
    return this.status();
  }

  refreshWorkers(): PoolStatus {
    this.countWorkers();
    if (this.running) for (const group of this.groups.values()) this.reconcile(group);
    this.publishPool();
    return this.status();
  }

  private countWorkers(): void {
    for (const group of this.groups.values()) {
      group.target = workerTarget(
        group.engine,
        this.deps.settings.workersOverride(group.engine.id),
      );
    }
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
    for (const { current, processing } of this.workers()) {
      if (!current || !matches(current.task)) continue;
      if (afterSettle) current.afterSettle.push(afterSettle);
      current.controller.abort();
      if (processing) settled.push(processing);
    }
    await Promise.all(settled);
  }

  private reconcile(group: Group): void {
    for (let index = 0; index < group.target; index++) {
      const worker = group.workers.get(index);
      if (worker) worker.retiring = false;
      else this.spawn(group, index);
    }
    for (const worker of group.workers.values()) {
      if (worker.index >= group.target) worker.retiring = true;
    }
    this.wake();
  }

  private spawn(group: Group, index: number): void {
    const worker: Worker = {
      group,
      index,
      retiring: false,
      sessions: new SessionHolder(group.engine, { idleMs: this.deps.sessionIdleMs }),
      current: null,
      processing: null,
      loop: Promise.resolve(),
    };
    group.workers.set(index, worker);
    worker.loop = this.work(worker);
  }

  private wake(): void {
    const wakers = [...this.wakers];
    this.wakers.clear();
    for (const wake of wakers) wake();
  }

  private async work(worker: Worker): Promise<void> {
    const { queue, catalog, logger, backoffMs = 1000 } = this.deps;
    const { group } = worker;
    while (this.running && !worker.retiring) {
      try {
        const task =
          this.paused || group.paused || this.gate.held
            ? null
            : queue.claimNext(catalog.languagesOn(group.engine.id));
        if (task) {
          worker.processing = this.process(worker, task);
          try {
            await worker.processing;
          } finally {
            worker.processing = null;
          }
          continue;
        }
        // Nothing can be queued between claimNext and here: both run in one tick.
        this.gate.offerIdle(() => this.idle());
        await new Promise<void>((resolve) => this.wakers.add(resolve));
      } catch (error) {
        // A database failure must not end the worker; wait a moment so it cannot spin.
        logger?.error({ err: error }, "worker could not take or record a chapter");
        await sleep(backoffMs, this.shutdown.signal);
      }
    }
    // Leave the map in the same tick as the check above, so a count that rises again spawns a new one.
    if (group.workers.get(worker.index) === worker) group.workers.delete(worker.index);
    // The last chapter may have ended on this worker: nobody else is left to notice the pool is idle.
    this.gate.offerIdle(() => this.idle());
    this.wake();
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
    const { meter } = worker.group;
    const startedAt = this.now();
    const calm = this.disturbances;
    const crowd = meter.enter();
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
    const wallSeconds = (this.now() - startedAt) / 1000;
    const concurrency = meter.averageSince(crowd);
    meter.leave();

    try {
      this.settle(worker.group, task, controller.signal, converted, failure, counts, {
        wallSeconds,
        concurrency,
        disturbed: this.disturbances !== calm,
      });
    } catch (error) {
      logger?.error(
        { err: error, bookId: task.bookId, chapter: task.position },
        "could not save the result of a chapter",
      );
      failBestEffort(this.deps, this.events, task, counts);
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
    group: Group,
    task: ClaimedChapter,
    signal: AbortSignal,
    converted: ConvertedChapter | null,
    failure: unknown,
    counts: Counts,
    timing: { wallSeconds: number; concurrency: number; disturbed: boolean },
  ): void {
    const { queue, converter, catalog, state, logger } = this.deps;
    const service = group.engine.id;
    const where = { bookId: task.bookId, chapter: task.position, service };

    if (converted) {
      if (queue.markDone(task, converted.audioPath, converted.durationSeconds)) {
        converter.discardChunks(task);
        state.recordSuccess(service);
        recordTiming(this.deps, service, task, converted, timing);
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

    if (failure instanceof TtsError && failure.code === "unreachable") {
      // The service is down, not the chapter's fault: it waits for the service, which gets no workers
      // until it answers again.
      logger?.warn({ detail: failure.detail, ...where }, "the TTS service does not answer");
      this.requeue(task, counts);
      this.refreshWorkers();
      void catalog.refresh(service);
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
    publishFailure(this.deps, this.events, task, counts, message);
    // Text that cannot be read says nothing about the service, and a voice that went away only
    // means the service's voice list changed, so neither counts towards pausing it. Everything else
    // (a crash, a timeout, a missing binary) does.
    if (failure instanceof TtsError && failure.code === "voice_not_found")
      void catalog.refresh(service);
    if (
      failure instanceof TtsError &&
      (failure.code === "bad_input" || failure.code === "voice_not_found")
    ) {
      return;
    }
    if (state.recordFailure(service, message)) {
      group.paused = true;
      logger?.error(
        { error: message, service },
        "three chapters of a TTS service failed in a row, its workers are paused",
      );
    }
  }

  private requeue(task: ClaimedChapter, counts: Counts): void {
    if (!this.deps.queue.requeue(task)) return;
    this.events.publish(chapterEvent(task, "queued", counts));
    this.wake(); // Another worker may be idle.
  }

  private publishPool(): void {
    this.events.publish({ type: "pool", ...this.status() });
  }
}
