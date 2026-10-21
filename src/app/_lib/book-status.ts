import type { Book, BookSummary } from "./api";
import { formatClock, formatMinutes, pluralize } from "./format";

const ready = (book: Pick<BookSummary, "doneCount" | "chapterCount">) =>
  `${book.doneCount} of ${pluralize(book.chapterCount, "chapter")} ready`;

/** The status line of a book in the library. */
export function libraryStatus(book: BookSummary): string {
  switch (book.status) {
    case "ready":
      return `Ready to convert · about ${formatMinutes(book.estimatedMinutes)}`;
    case "converting":
      return `Converting · ${ready(book)}`;
    case "paused":
      return `Paused · ${ready(book)}`;
    case "done":
      return `Ready to listen · ${ready(book)} · ${formatClock(book.durationSeconds)}`;
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

/** Keep refreshing a book while work is going on or about to. */
export const bookIsBusy = (book: Book): boolean =>
  book.status === "converting" ||
  (book.status === "paused" && book.chapters.some((chapter) => chapter.status === "generating"));

export const libraryIsBusy = (books: BookSummary[]): boolean =>
  books.some((book) => book.status === "converting" || book.status === "paused");
