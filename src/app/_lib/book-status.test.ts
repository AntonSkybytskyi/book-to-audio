import { describe, expect, it } from "vitest";
import type { Book, BookSummary, Chapter } from "./api";
import {
  bookIsBusy,
  bookSummary,
  libraryIsBusy,
  libraryStatus,
  overallProgress,
} from "./book-status";

const summary = (overrides: Partial<BookSummary> = {}): BookSummary => ({
  id: "b",
  title: "Book",
  author: null,
  language: "en",
  status: "converting",
  hasCover: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  chapterCount: 10,
  doneCount: 3,
  failedCount: 0,
  wordCount: 1000,
  estimatedMinutes: 90,
  durationSeconds: 3725,
  ...overrides,
});

const chapter = (position: number, overrides: Partial<Chapter> = {}): Chapter => ({
  position,
  title: `C${position}`,
  status: "queued",
  progress: 0,
  error: null,
  charCount: 1,
  wordCount: 1,
  estimatedMinutes: 1,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  hasAudio: false,
  audioVersion: 0,
  regenError: null,
  ...overrides,
});

const book = (overrides: Partial<Book> = {}): Book => ({
  ...summary(),
  chapters: [chapter(1), chapter(2)],
  availableLanguages: ["en"],
  ...overrides,
});

describe("libraryStatus", () => {
  it("says how many chapters are ready in every state but ready", () => {
    expect(libraryStatus(summary({ status: "ready" }))).toBe("Ready to convert · about 1 h 30 min");
    expect(libraryStatus(summary())).toBe("Converting · 3 of 10 chapters ready");
    expect(libraryStatus(summary({ status: "paused" }))).toBe("Paused · 3 of 10 chapters ready");
    expect(libraryStatus(summary({ status: "done", doneCount: 10 }))).toBe(
      "Ready to listen · 10 of 10 chapters ready · 1:02:05",
    );
    expect(libraryStatus(summary({ status: "done_with_errors", failedCount: 1 }))).toBe(
      "1 chapter failed · 3 of 10 chapters ready",
    );
  });
});

describe("bookSummary", () => {
  it("tells a paused book from a pool that is paused for everything", () => {
    const own = bookSummary(book({ status: "paused" }), false);
    const pool = bookSummary(book(), true);

    expect(own).toMatch(/^Paused:/);
    expect(pool).toMatch(/^Waiting: conversion is paused for every book/);
    expect(bookSummary(book({ status: "paused" }), true)).toMatch(/^Paused:/);
  });

  it("says whether a paused book is still finishing chapters", () => {
    const running = book({ status: "paused", chapters: [chapter(1, { status: "generating" })] });

    expect(bookSummary(running, false)).toContain("already started will finish");
    expect(bookSummary(book({ status: "paused" }), false)).toContain("nothing is being read");
  });

  it("covers the other states", () => {
    expect(bookSummary(book({ status: "ready" }), false)).toBe("Not converted yet.");
    expect(bookSummary(book(), false)).toBe("Converting: 3 of 10 chapters ready.");
    expect(bookSummary(book({ status: "done", doneCount: 10 }), false)).toBe(
      "All 10 chapters are ready, 1:02:05 in total.",
    );
    expect(bookSummary(book({ status: "done_with_errors", failedCount: 2 }), false)).toBe(
      "Finished with 2 failed chapters. 3 of 10 chapters are ready.",
    );
  });
});

describe("progress and polling", () => {
  it("counts finished chapters fully and running ones by their progress", () => {
    const chapters = [
      chapter(1, { status: "done" }),
      chapter(2, { status: "generating", progress: 0.5 }),
      chapter(3, { status: "queued", progress: 0.9 }),
      chapter(4),
    ];

    expect(overallProgress(book({ chapters }))).toBe(0.375);
    expect(overallProgress(book({ chapters: [] }))).toBe(0);
  });

  it("keeps refreshing a paused book only while it still has a running chapter", () => {
    const running = [chapter(1, { status: "generating" })];

    expect(bookIsBusy(book())).toBe(true);
    expect(bookIsBusy(book({ status: "paused", chapters: running }))).toBe(true);
    expect(bookIsBusy(book({ status: "paused" }))).toBe(false);
    expect(bookIsBusy(book({ status: "done" }))).toBe(false);
  });

  it("keeps refreshing the library while a book is converting or paused", () => {
    expect(libraryIsBusy([summary({ status: "done" }), summary({ status: "paused" })])).toBe(true);
    expect(libraryIsBusy([summary({ status: "done" }), summary({ status: "ready" })])).toBe(false);
  });
});
