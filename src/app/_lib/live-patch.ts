import type { Book, BookSummary, Outputs } from "./api";
import type { AppEvent, OutputsEvent } from "./events";

/** The downloads part of an outputs event. */
const outputsOf = ({
  state,
  available,
  updating,
  progress,
  error,
  m4bBytes,
  zipBytes,
}: OutputsEvent): Outputs => ({
  state,
  available,
  updating,
  progress,
  error,
  m4bBytes,
  zipBytes,
});

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
            regenError: event.regenError,
            durationSeconds: event.durationSeconds ?? chapter.durationSeconds,
            // A chapter keeps its old audio while it is regenerated, so only a new file changes these.
            audioVersion: event.audioVersion ?? chapter.audioVersion,
            hasAudio: chapter.hasAudio || event.status === "done",
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

  if (event.type === "outputs" && event.bookId === book.id) {
    return { ...book, outputs: outputsOf(event) };
  }

  if (event.type === "book" && event.bookId === book.id) {
    // Converting a ready book changes every chapter (Convert, in another tab): load them again.
    // Any other change of status (pause, resume, done, regenerate) leaves the chapters to their own events.
    if (event.status !== book.status && (book.status === "ready" || event.status === "ready")) {
      return null;
    }
    return {
      ...book,
      status: event.status,
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
  if (event.type === "book-deleted") {
    return books.some((book) => book.id === event.bookId)
      ? books.filter((book) => book.id !== event.bookId)
      : books;
  }
  if (event.type === "outputs") {
    return books.map((book) =>
      book.id === event.bookId ? { ...book, outputs: outputsOf(event) } : book,
    );
  }
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
