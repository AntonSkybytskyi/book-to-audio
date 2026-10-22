import type { TextPreparer } from "../convert/chapter-text.js";
import type { EventBus } from "../events/bus.js";
import { TtsError } from "../tts/engine.js";
import { Limiter } from "./limiter.js";
import { CountBudget, countPreparedDetailed } from "./prepared-chars.js";
import type { CountRepository } from "./count-repository.js";

export interface CounterLogger {
  warn(context: object, message: string): void;
}

export interface CounterDeps {
  repo: Pick<CountRepository, "bookLanguage" | "pending" | "setCounts" | "uncountedBookIds">;
  prepare: TextPreparer;
  maxChars: number;
  bus: EventBus;
  /** Shared with whatever else runs the text rules, so only a few worker threads exist at once. */
  limiter?: Limiter;
  /** The time a book's count may take once its rules have started, and the clock that tells. */
  budget?: { ms?: number; now?: () => number };
  /** Waits before each new try at a book that was only counted approximately or failed; its length is the number of tries. */
  retryDelaysMs?: readonly number[];
  /** Called when no count is under way any more. */
  onIdle?: () => void;
  logger?: CounterLogger;
}

/** Text rules running at once for counting; each is a worker thread that can take a core. */
export const COUNT_CONCURRENCY = 2;

/** One minute, five minutes, half an hour. */
export const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

interface Job {
  language: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Counts, in the background, the characters of prepared text of each chapter of a book: the length
 * the time estimates are made from. An upload or a change of language returns at once with the
 * count missing (`measuring`), and the page is told when it lands. A job drops its result when the
 * book was deleted, or its language changed, meanwhile; the next job is already on its way then.
 *
 * A chapter the rules gave up on (or had no time for) is stored with its raw length as a stand-in
 * and marked approximate, and counted again later, a few times with growing waits; so is a book whose
 * count failed for another reason (the database was busy).
 */
export class PreparedCounter {
  private readonly jobs = new Map<string, Job>();
  private readonly retries = new Map<
    string,
    { tries: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private stopped = false;
  private readonly limiter: Limiter;
  /** The text rules, held to the same few worker threads as the counting; for other work that needs them. */
  readonly prepare: TextPreparer;

  constructor(private readonly deps: CounterDeps) {
    this.limiter = deps.limiter ?? new Limiter(COUNT_CONCURRENCY);
    this.prepare = (text, language, maxChars, signal) =>
      this.limiter.run(() => deps.prepare(text, language, maxChars, signal));
  }

  /** Counts the book, replacing a count that is under way for another language. */
  enqueue(bookId: string): void {
    if (this.stopped) return;
    const language = this.deps.repo.bookLanguage(bookId);
    if (language === undefined) return;
    const running = this.jobs.get(bookId);
    if (running?.language === language) return;
    if (running) {
      running.controller.abort();
      this.retries.delete(bookId); // another language: a fresh start
    }
    const waiting = this.retries.get(bookId);
    if (waiting?.timer) clearTimeout(waiting.timer);
    const controller = new AbortController();
    const job: Job = { language, controller, done: Promise.resolve() };
    job.done = this.run(bookId, job).finally(() => {
      if (this.jobs.get(bookId) === job) this.jobs.delete(bookId);
      if (this.jobs.size === 0) this.deps.onIdle?.();
    });
    this.jobs.set(bookId, job);
  }

  /** Every book that has a chapter with no count yet (or only a stand-in), such as books from before counts were kept. */
  backfill(): void {
    for (const id of this.deps.repo.uncountedBookIds()) this.enqueue(id);
  }

  /** A count is under way. */
  get busy(): boolean {
    return this.jobs.size > 0;
  }

  /** Resolves when no count is under way (a retry that is only waiting for its time does not count). */
  async whenIdle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }

  /** Cancels what is under way and ignores new work. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    for (const id of this.retries.keys()) this.cancelRetry(id);
    await this.whenIdle();
  }

  private cancelRetry(bookId: string): void {
    const retry = this.retries.get(bookId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(bookId);
  }

  /** Tries the book again after a wait, a bounded number of times. */
  private scheduleRetry(bookId: string): void {
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const tries = this.retries.get(bookId)?.tries ?? 0;
    if (this.stopped || tries >= delays.length) return;
    const timer = setTimeout(() => {
      const state = this.retries.get(bookId);
      if (state) state.timer = null;
      this.enqueue(bookId);
    }, delays[tries]);
    timer.unref();
    this.retries.set(bookId, { tries: tries + 1, timer });
  }

  private async run(bookId: string, job: Job): Promise<void> {
    const { repo, bus, maxChars, logger } = this.deps;
    const { language, controller } = job;
    try {
      const pending = repo.pending(bookId);
      if (pending.length === 0) {
        this.retries.delete(bookId);
        return;
      }
      // The time budget runs from the first rule run of this book, not from when it waited its turn.
      const budget = new CountBudget(this.deps.budget?.ms, this.deps.budget?.now);
      const counted = await countPreparedDetailed(
        pending.map((chapter) => chapter.text),
        language,
        maxChars,
        (text, lang, max, signal) =>
          this.limiter.run(() => {
            budget.start();
            return this.deps.prepare(text, lang, max, signal);
          }),
        controller.signal,
        { budget, shouldStop: () => repo.bookLanguage(bookId) !== language },
      );
      if (controller.signal.aborted) return;
      const saved = repo.setCounts(
        bookId,
        language,
        counted.map((count, i) => ({ position: pending[i]?.position ?? 0, ...count })),
      );
      if (!saved) return;
      bus.publish({ type: "book-counted", bookId });
      if (counted.some((count) => count.approx)) this.scheduleRetry(bookId);
      else this.retries.delete(bookId);
    } catch (error) {
      if (error instanceof TtsError && error.code === "aborted") return;
      logger?.warn({ err: error, bookId }, "could not count the prepared text of a book");
      this.scheduleRetry(bookId);
    }
  }
}
