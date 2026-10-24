import type { ClaimedChapter } from "../books/queue.js";
import type { ProgressPublisher } from "../events/throttle.js";
import type { ConvertedChapter } from "./convert-chapter.js";
import { chapterEvent, type Counts } from "./pool-events.js";
import type { ChapterTiming, PoolDeps } from "./pool-types.js";

/**
 * A chapter that has audio was being regenerated: it is `done` again with that audio and
 * keeps the message as a note, and its chunks are no longer needed. Any other becomes `failed`.
 */
export function publishFailure(
  deps: PoolDeps,
  events: ProgressPublisher,
  task: ClaimedChapter,
  counts: Counts,
  error: string,
): void {
  if (!deps.queue.hasAudio(task.id)) {
    events.publish({ ...chapterEvent(task, "failed", counts), error });
    return;
  }
  events.publish({
    ...chapterEvent(task, "done", { done: 0, total: 0 }),
    progress: 1,
    regenError: error,
  });
  // After the event and the failure count: leftover chunks are only waste, and a failure
  // to remove them must not hide what happened. The startup sweep removes them.
  try {
    deps.converter.discardChunks(task);
  } catch (cause) {
    deps.logger?.warn(
      { err: cause, bookId: task.bookId, chapter: task.position },
      "could not remove the chunks of a failed regeneration",
    );
  }
}

/** Last resort when saving a result failed, so the chapter is not left `generating`. */
export function failBestEffort(
  deps: PoolDeps,
  events: ProgressPublisher,
  task: ClaimedChapter,
  counts: Counts,
): void {
  const message = "The result of this chapter could not be saved.";
  try {
    if (deps.queue.markFailed(task, message)) publishFailure(deps, events, task, counts, message);
  } catch (error) {
    // The next start re-queues anything still generating.
    deps.logger?.error({ err: error, bookId: task.bookId }, "chapter left generating");
  }
}

/** Tells the speed estimates how long the chapter took; never lets that fail the chapter. */
export function recordTiming(
  deps: PoolDeps,
  engine: string,
  task: ClaimedChapter,
  converted: ConvertedChapter,
  {
    wallSeconds,
    concurrency,
    disturbed,
  }: Pick<ChapterTiming, "wallSeconds" | "concurrency"> & { disturbed: boolean },
): void {
  const { voiceId, preparedChars, retries = 0 } = converted;
  // A chapter that continued from saved chunks, retried one, or ran while the pool was held,
  // paused or resumed took less or more than its length says.
  if (!deps.learner || !voiceId || !preparedChars || task.chunksDone > 0 || retries > 0) return;
  if (disturbed) return;
  try {
    deps.learner.recordChapter({
      engine,
      voiceId,
      language: task.language,
      preparedChars,
      durationSeconds: converted.durationSeconds,
      wallSeconds,
      concurrency,
    });
  } catch (error) {
    deps.logger?.error(
      { err: error, bookId: task.bookId },
      "could not record how long a chapter took",
    );
  }
}
