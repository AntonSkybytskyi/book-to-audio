import { conversionSeconds, remainingAudio } from "../../shared/estimate";
import type { Book, BookEstimate, BookSummary, PoolStatus, SpeedSource } from "./api";
import { aboutDuration, formatApprox, pluralize } from "./format";

const roughNote = (source: SpeedSource) => (source === "rough" ? " (rough estimate)" : "");
const books = (count: number) => pluralize(count, "book");

/** `about 2 h 15 min left`, or `less than a minute left`. */
export function leftPhrase(seconds: number): string {
  return seconds < 60 ? "less than a minute left" : `${aboutDuration(seconds)} left`;
}

/** The book's remaining time from its chapters as they are now, so it moves as chunks finish. */
export function remainingNow(book: Book, workers: number): number | null {
  if (!book.speed) return book.timeLeft?.remainingSeconds ?? null;
  return conversionSeconds(book.speed, remainingAudio(book.speed, book.chapters), workers);
}

/** What waits in front of a book that is queued behind others. */
function waitingPhrase(ahead: number, startsInSeconds: number | null): string {
  const who = `Starts after ${books(ahead)}`;
  return startsInSeconds === null ? `${who}.` : `${who}, in ${aboutDuration(startsInSeconds)}.`;
}

/**
 * The line about the time left on the book page, or null when there is nothing to say (the
 * book is not being converted). Paused books and a paused pool get words, not a number.
 */
export function bookTimeLeft(
  book: Book,
  pool: PoolStatus | null,
  /** Seconds the speed test is expected to take yet, if the page knows (else the server's figure is used). */
  speedTestSeconds: number | null = null,
): string | null {
  const left = book.timeLeft;
  if (!left || (book.status !== "converting" && book.status !== "paused")) return null;
  if (book.status === "paused")
    return "Time left: paused. It shows again when you resume the book.";
  if (pool?.state === "paused" || left.state === "pool_paused") {
    return "Time left: paused, because all conversion is paused.";
  }
  const workers = pool?.workers ?? book.estimate?.workers ?? 1;
  const remaining = remainingNow(book, workers);
  if (remaining === null) return null;
  const rough = roughNote(left.source);
  const reading = book.chapters.some((chapter) => chapter.status === "generating");
  if ((pool?.held ?? left.state === "waiting_for_speed_test") && !reading) {
    return `${waitingForSpeedTest(speedTestSeconds ?? left.speedTestSeconds)}, then ${aboutDuration(remaining)} left${rough}.`;
  }
  if (left.state === "waiting") {
    return `${waitingPhrase(left.booksAhead, left.startsInSeconds)} Then ${aboutDuration(remaining)}${rough}.`;
  }
  return `${capitalize(leftPhrase(remaining))}${rough}.`;
}

/** `Waiting for a speed test (about 2 min)`; without a figure, just that it is waiting. */
export function waitingForSpeedTest(seconds: number | null): string {
  return seconds === null
    ? "Waiting for a speed test"
    : `Waiting for a speed test (${aboutDuration(seconds)})`;
}

/** The time left in the library line of a converting or paused book, or null. */
export function libraryTimeLeft(book: BookSummary, poolPaused: boolean): string | null {
  const left = book.timeLeft;
  if (!left) return null;
  if (left.state === "paused") return "time left paused";
  if (poolPaused || left.state === "pool_paused") return "time left paused";
  if (left.remainingSeconds === null) return null;
  if (left.state === "waiting_for_speed_test") {
    return `${waitingForSpeedTest(left.speedTestSeconds).toLowerCase()}, then ${aboutDuration(left.remainingSeconds)} left${roughNote(left.source)}`;
  }
  if (left.state === "waiting") {
    const start =
      left.startsInSeconds === null
        ? `starts after ${books(left.booksAhead)}`
        : `starts in ${aboutDuration(left.startsInSeconds)}`;
    return `${start}, then ${aboutDuration(left.remainingSeconds)}`;
  }
  return `${leftPhrase(left.remainingSeconds)}${roughNote(left.source)}`;
}

export interface PreviewText {
  /** `About 10 h 20 min of audio`. */
  audio: string;
  /** `converting takes about 2 h 15 min on this computer with 4 workers`. */
  convert: string;
  /** Set when other books are converting first. */
  queue: string | null;
  /** Said once, plainly, when no speed test has measured this computer. */
  rough: boolean;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The sentences under the chapter list's title on the preview. */
export function previewText(estimate: BookEstimate): PreviewText {
  const { audioSeconds, convertSeconds, workers, queue } = estimate;
  const audio =
    audioSeconds < 60
      ? "Under a minute of audio"
      : `${capitalize(aboutDuration(audioSeconds))} of audio`;
  const convert = `converting takes ${aboutDuration(convertSeconds)} on this computer with ${pluralize(workers, "worker")}`;
  const queueText =
    queue.booksAhead === 0
      ? null
      : `Other books are converting first: this one would start after ${books(queue.booksAhead)}${
          queue.startsInSeconds === null ? "" : `, in ${aboutDuration(queue.startsInSeconds)}`
        }.`;
  return { audio, convert, queue: queueText, rough: estimate.source === "rough" };
}

/** A chapter's length on the preview: `about 12 min`, `under a minute`. */
export const chapterLength = (seconds: number | null): string | null =>
  seconds === null ? null : seconds < 60 ? "under a minute" : formatApprox(seconds);
