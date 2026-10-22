import type { Book, BookSummary } from "./api";
import { aboutDuration, formatClock, pluralize } from "./format";
import { libraryTimeLeft } from "./time-left";

const ready = (book: Pick<BookSummary, "doneCount" | "chapterCount">) =>
  `${book.doneCount} of ${pluralize(book.chapterCount, "chapter")} ready`;

const withLeft = (head: string, left: string | null) => (left ? `${head} · ${left}` : head);

/** The status line of a book in the library. `poolPaused`: all conversion is paused. */
export function libraryStatus(book: BookSummary, poolPaused = false): string {
  switch (book.status) {
    case "ready":
      return book.estimate
        ? `Ready to convert · ${aboutDuration(book.estimate.audioSeconds)} of audio`
        : "Ready to convert";
    case "converting":
      return withLeft(`Converting · ${ready(book)}`, libraryTimeLeft(book, poolPaused));
    case "paused":
      return withLeft(`Paused · ${ready(book)}`, libraryTimeLeft(book, poolPaused));
    case "done":
      return `Ready to listen · ${ready(book)} · ${formatClock(book.durationSeconds)}${book.outputs.available ? " · Ready to download" : ""}`;
    case "done_with_errors":
      return `${pluralize(book.failedCount, "chapter")} failed · ${ready(book)}`;
  }
}

/**
 * The line under the progress bar on the book page. `poolPaused` is the pause of all
 * conversion (a failing engine, a full disk); `paused` is this book's own pause.
 */
export function bookSummary(book: Book, poolPaused: boolean): string {
  const total = pluralize(book.chapterCount, "chapter");
  const running = book.chapters.some((chapter) => chapter.status === "generating");
  switch (book.status) {
    case "ready":
      return "Not converted yet.";
    case "converting":
      if (poolPaused) {
        return `Waiting: conversion is paused for every book. ${book.doneCount} of ${total} ready.`;
      }
      return `Converting: ${book.doneCount} of ${total} ready.`;
    case "paused":
      return running
        ? `Paused: the chapters already started will finish, then nothing more is read. ${book.doneCount} of ${total} ready.`
        : `Paused: nothing is being read. ${book.doneCount} of ${total} ready.`;
    case "done":
      return `All ${total} are ready, ${formatClock(book.durationSeconds)} in total.`;
    case "done_with_errors":
      return `Finished with ${pluralize(book.failedCount, "failed chapter")}. ${book.doneCount} of ${total} are ready.`;
  }
}

/** Overall progress: finished chapters count fully, running ones by their own progress. */
export function overallProgress(book: Book): number {
  if (book.chapters.length === 0) return 0;
  const sum = book.chapters.reduce(
    (total, c) => total + (c.status === "done" ? 1 : c.status === "generating" ? c.progress : 0),
    0,
  );
  return sum / book.chapters.length;
}

/** A finished book whose downloads are not there yet and have not failed: they are about to change. */
const downloadsPending = (book: BookSummary): boolean =>
  book.status === "done" && !book.outputs.available && book.outputs.state !== "failed";

/** Keep refreshing a book while work is going on or about to. */
export const bookIsBusy = (book: Book): boolean =>
  book.measuring ||
  book.status === "converting" ||
  (book.status === "paused" && book.chapters.some((chapter) => chapter.status === "generating")) ||
  downloadsPending(book);

export const libraryIsBusy = (books: BookSummary[]): boolean =>
  books.some(
    (book) =>
      book.measuring ||
      book.status === "converting" ||
      book.status === "paused" ||
      downloadsPending(book),
  );
