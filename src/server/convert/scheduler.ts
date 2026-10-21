import type { ChapterQueue, ClaimedChapter } from "../books/queue.js";
import { GENERIC_CHAPTER_ERROR, UserFacingError } from "../errors.js";
import type { ChapterConverter } from "./convert-chapter.js";

export interface SchedulerLogger {
  info(message: string): void;
  error(context: object, message: string): void;
}

export interface SchedulerDeps {
  queue: ChapterQueue;
  convert: ChapterConverter;
  logger?: SchedulerLogger;
  /** Pause after the loop hits a database error. Tests shorten it. */
  backoffMs?: number;
}

/**
 * Runs queued chapters one at a time, earliest book first. Slice 2 replaces
 * the loop with a pool of workers; callers only use `start`, `stop` and `notify`.
 */
export class Scheduler {
  private loop: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private current: AbortController | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Re-queues interrupted chapters and starts taking work. */
  start(): void {
    if (this.loop) return;
    const { queue, logger } = this.deps;
    const reset = queue.resetInterrupted();
    if (reset > 0) logger?.info(`re-queued ${reset} interrupted chapter(s)`);
    queue.refreshAllConverting();
    this.stopping = false;
    this.loop = this.run();
  }

  /** Cancels the running chapter, which goes back to the queue, and waits for the loop to end. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.abort();
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  /** Tells an idle loop that new chapters were queued. */
  notify(): void {
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const task = this.deps.queue.claimNext();
        if (task) {
          await this.process(task);
          continue;
        }
        // Nothing can be queued between claimNext and here: both run in one tick.
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      } catch (error) {
        // A database failure must not end the loop; wait a moment so it cannot spin.
        this.deps.logger?.error({ err: error }, "scheduler could not take or record a chapter");
        await new Promise((resolve) => setTimeout(resolve, this.deps.backoffMs ?? 1000));
      }
    }
  }

  private async process(task: ClaimedChapter): Promise<void> {
    const { queue, convert, logger } = this.deps;
    const controller = new AbortController();
    this.current = controller;

    // Converting and saving the outcome fail for different reasons, so they are
    // kept apart: a save that throws must not be mistaken for a bad chapter.
    let converted: Awaited<ReturnType<ChapterConverter>> | null = null;
    let failure: unknown = null;
    try {
      converted = await convert(task, (p) => queue.setProgress(task.id, p), controller.signal);
    } catch (error) {
      failure = error;
    }
    this.current = null;

    try {
      if (controller.signal.aborted) {
        queue.requeue(task.id);
      } else if (converted) {
        queue.markDone(task.id, converted.audioPath, converted.durationSeconds);
      } else {
        const bookChapter = { bookId: task.bookId, chapter: task.position };
        logger?.error(
          { err: failure, detail: (failure as UserFacingError | null)?.detail, ...bookChapter },
          "chapter failed",
        );
        queue.markFailed(
          task.id,
          failure instanceof UserFacingError ? failure.message : GENERIC_CHAPTER_ERROR,
        );
      }
    } catch (error) {
      logger?.error(
        { err: error, bookId: task.bookId, chapter: task.position },
        "could not save the result of a chapter",
      );
      this.markFailedBestEffort(task, "The result of this chapter could not be saved.");
    }

    try {
      queue.refreshBookStatus(task.bookId);
    } catch (error) {
      logger?.error({ err: error, bookId: task.bookId }, "could not update the book status");
    }
  }

  /** Last resort when saving a result failed, so the chapter is not left `generating`. */
  private markFailedBestEffort(task: ClaimedChapter, message: string): void {
    try {
      this.deps.queue.markFailed(task.id, message);
    } catch (error) {
      // The next start re-queues anything still generating.
      this.deps.logger?.error({ err: error, bookId: task.bookId }, "chapter left generating");
    }
  }
}
