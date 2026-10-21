import type { Book, BookSummary } from "./api";
import type { AppEvent } from "./events";

/**
 * Applies a live event to a book. Returns the same object when the event is not
 * about this book, and null when the page cannot tell what changed (a chapter it
 * does not know, a book that moved to another status) and should reload instead.
 */
export function patchBook(book: Book, event: AppEvent): Book | null {
  if (event.type === "chapter" && event.bookId === book.id) {
    if (!book.chapters.some((chapter) => chapter.position === event.position)) return null;
    const chapters = book.chapters.map((chapter) =>
      chapter.position === event.position
        ? {
            ...chapter,
            status: event.status,
            progress: event.progress,
            chunkCount: event.chunkCount,
            chunksDone: event.chunksDone,
            error: event.error,
            durationSeconds: event.durationSeconds ?? chapter.durationSeconds,
          }
        : chapter,
    );
    return {
      ...book,
      chapters,
      doneCount: chapters.filter((chapter) => chapter.status === "done").length,
      failedCount: chapters.filter((chapter) => chapter.status === "failed").length,
      durationSeconds: chapters.reduce(
        (total, chapter) =>
          total + (chapter.status === "done" ? (chapter.durationSeconds ?? 0) : 0),
        0,
      ),
    };
  }

  if (event.type === "book" && event.bookId === book.id) {
    // Every chapter changed with the status (Convert, in another tab): load them again.
    if (event.status !== book.status) return null;
    return {
      ...book,
      doneCount: event.doneCount,
      failedCount: event.failedCount,
      durationSeconds: event.durationSeconds,
    };
  }

  return book;
}

/** Applies a live event to the library list, or returns null when it must be loaded again. */
export function patchLibrary(books: BookSummary[], event: AppEvent): BookSummary[] | null {
  if (event.type === "book-added") return null;
  if (event.type !== "book") return books;
  if (!books.some((book) => book.id === event.bookId)) return null;
  return books.map((book) =>
    book.id === event.bookId
      ? {
          ...book,
          status: event.status,
          doneCount: event.doneCount,
          failedCount: event.failedCount,
          durationSeconds: event.durationSeconds,
        }
      : book,
  );
}
