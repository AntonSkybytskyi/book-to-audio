import { describe, expect, it } from "vitest";
import type { Book, BookSummary, Chapter } from "./api";
import type { AppEvent } from "./events";
import { isFinishing } from "./chapter";
import { patchBook, patchLibrary } from "./live-patch";

const chapter = (position: number, overrides: Partial<Chapter> = {}): Chapter => ({
  position,
  title: `Chapter ${position}`,
  status: "queued",
  progress: 0,
  error: null,
  charCount: 100,
  wordCount: 20,
  estimatedMinutes: 1,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  ...overrides,
});

const book = (overrides: Partial<Book> = {}): Book => ({
  id: "b1",
  title: "Book",
  author: null,
  language: "en",
  status: "converting",
  hasCover: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  chapterCount: 3,
  doneCount: 0,
  failedCount: 0,
  wordCount: 60,
  estimatedMinutes: 3,
  durationSeconds: 0,
  chapters: [chapter(1), chapter(2), chapter(3)],
  availableLanguages: ["en"],
  ...overrides,
});

const chapterEvent = (
  overrides: Partial<Extract<AppEvent, { type: "chapter" }>> = {},
): AppEvent => ({
  type: "chapter",
  bookId: "b1",
  position: 2,
  status: "generating",
  progress: 0.4,
  error: null,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  ...overrides,
});

const summary = (id: string): BookSummary => ({
  id,
  title: id,
  author: null,
  language: "en",
  status: "converting",
  hasCover: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  chapterCount: 4,
  doneCount: 0,
  failedCount: 0,
  wordCount: 80,
  estimatedMinutes: 4,
  durationSeconds: 0,
});
describe("patchBook", () => {
  it("updates the chapter that the event is about and nothing else", () => {
    const before = book();

    const after = patchBook(before, chapterEvent());

    expect(after?.chapters.map((c) => [c.status, c.progress])).toEqual([
      ["queued", 0],
      ["generating", 0.4],
      ["queued", 0],
    ]);
    expect(after?.chapters[0]).toBe(before.chapters[0]); // untouched rows keep their identity
    expect(before.chapters[1]?.status).toBe("queued"); // the old state is not mutated
  });

  it("follows the chunk counts, so a chapter that has read everything shows as finishing", () => {
    const reading = patchBook(
      book(),
      chapterEvent({ progress: 0.5, chunkCount: 8, chunksDone: 4 }),
    );
    const joining = patchBook(book(), chapterEvent({ progress: 1, chunkCount: 8, chunksDone: 8 }));

    expect(reading?.chapters[1]).toMatchObject({ chunkCount: 8, chunksDone: 4 });
    expect(reading?.chapters[1] && isFinishing(reading.chapters[1])).toBe(false);
    expect(joining?.chapters[1] && isFinishing(joining.chapters[1])).toBe(true);
  });

  it("recounts finished and failed chapters and the total duration", () => {
    let current = book();

    current =
      patchBook(
        current,
        chapterEvent({ position: 1, status: "done", progress: 1, durationSeconds: 60 }),
      ) ?? current;
    current =
      patchBook(
        current,
        chapterEvent({ position: 2, status: "failed", progress: 0, error: "Engine down." }),
      ) ?? current;
    current =
      patchBook(
        current,
        chapterEvent({ position: 3, status: "done", progress: 1, durationSeconds: 30 }),
      ) ?? current;

    expect(current).toMatchObject({ doneCount: 2, failedCount: 1, durationSeconds: 90 });
    expect(current.chapters[1]).toMatchObject({ status: "failed", error: "Engine down." });
  });

  it("keeps the known duration when a later event has none", () => {
    const before = book({
      chapters: [
        chapter(1, { status: "done", durationSeconds: 12, progress: 1 }),
        chapter(2),
        chapter(3),
      ],
    });

    const after = patchBook(before, chapterEvent({ position: 1, status: "done", progress: 1 }));

    expect(after?.chapters[0]?.durationSeconds).toBe(12);
  });

  it("ignores events about other books and pool events", () => {
    const before = book();

    expect(patchBook(before, chapterEvent({ bookId: "other" }))).toBe(before);
    expect(
      patchBook(before, {
        type: "pool",
        state: "paused",
        error: "x",
        cause: "failures",
        workers: 1,
        activeWorkers: 0,
      }),
    ).toBe(before);
    expect(patchBook(before, { type: "book-added", bookId: "b1" })).toBe(before);
  });

  it("asks for a reload when the chapter is unknown", () => {
    expect(patchBook(book(), chapterEvent({ position: 9 }))).toBeNull();
  });

  it("takes the counts of a book event, and asks for a reload when the status changed", () => {
    const same: AppEvent = {
      type: "book",
      bookId: "b1",
      status: "converting",
      doneCount: 2,
      failedCount: 1,
      durationSeconds: 75,
    };
    const changed: AppEvent = { ...same, status: "done_with_errors" };

    expect(patchBook(book(), same)).toMatchObject({
      doneCount: 2,
      failedCount: 1,
      durationSeconds: 75,
    });
    expect(patchBook(book(), changed)).toBeNull();
    expect(patchBook(book({ status: "ready" }), { ...same, status: "converting" })).toBeNull();
  });
});

describe("patchLibrary", () => {
  const bookEvent: AppEvent = {
    type: "book",
    bookId: "b2",
    status: "done",
    doneCount: 4,
    failedCount: 0,
    durationSeconds: 240,
  };

  it("updates the status and counts of the book in the event", () => {
    const books = [summary("b1"), summary("b2")];

    const after = patchLibrary(books, bookEvent);

    expect(after?.[1]).toMatchObject({ status: "done", doneCount: 4, durationSeconds: 240 });
    expect(after?.[0]).toBe(books[0]);
  });

  it("asks for a reload for a book it does not know and for a new book", () => {
    expect(patchLibrary([summary("b1")], bookEvent)).toBeNull();
    expect(patchLibrary([summary("b1")], { type: "book-added", bookId: "b3" })).toBeNull();
  });

  it("leaves the list alone for chapter and pool events", () => {
    const books = [summary("b1")];

    expect(patchLibrary(books, chapterEvent())).toBe(books);
  });
});
