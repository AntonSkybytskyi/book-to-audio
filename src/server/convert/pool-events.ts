import type { ClaimedChapter } from "../books/queue.js";
import type { ChapterStatus } from "../books/repository.js";
import type { ChapterEvent } from "../events/bus.js";

/** Chunks of the chapter that are finished, and how many there are. */
export interface Counts {
  done: number;
  total: number;
}

const fraction = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 0);

/** The chapter event for a chapter in `status`; the caller adds what is special about it. */
export function chapterEvent(
  task: ClaimedChapter,
  status: ChapterStatus,
  counts: Counts,
): ChapterEvent {
  return {
    type: "chapter",
    bookId: task.bookId,
    position: task.position,
    status,
    progress: fraction(counts.done, counts.total),
    error: null,
    durationSeconds: null,
    chunkCount: counts.total,
    chunksDone: counts.done,
    audioVersion: null,
    regenError: null,
  };
}
