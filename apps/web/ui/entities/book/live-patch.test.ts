import { describe, expect, it } from "vitest";
import { NO_OUTPUTS, type Book, type BookSummary, type Chapter } from "./api";
import { isFinishing } from "./chapter";
import { patchBook, patchLibrary, type LiveEvent } from "./live-patch";

const chapter = (position: number, overrides: Partial<Chapter> = {}): Chapter => ({
  position,
  title: `Chapter ${position}`,
  status: "queued",
  progress: 0,
  error: null,
  charCount: 100,
  wordCount: 20,
  preparedChars: 1,
  estimatedSeconds: 60,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  hasAudio: false,
  audioVersion: 0,
  regenError: null,
  ...overrides,
});

const book = (overrides: Partial<Book> = {}): Book => ({
  id: "b1",
  title: "Book",
  author: null,
  language: "en",
  languageSource: "detected",
  languageConfidence: 1,
  declaredLanguage: null,
  status: "converting",
  hasCover: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  chapterCount: 3,
  doneCount: 0,
  failedCount: 0,
  wordCount: 60,
  estimate: null,
  measuring: false,
  timeLeft: null,
  durationSeconds: 0,
  outputs: NO_OUTPUTS,
  speed: null,
  chapters: [chapter(1), chapter(2), chapter(3)],
  availableLanguages: ["en"],
  ...overrides,
});

const chapterEvent = (
  overrides: Partial<Extract<LiveEvent, { type: "chapter" }>> = {},
): LiveEvent => ({
  type: "chapter",
  bookId: "b1",
  position: 2,
  status: "generating",
  progress: 0.4,
  error: null,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  audioVersion: null,
  regenError: null,
  ...overrides,
});

const summary = (id: string, overrides: Partial<BookSummary> = {}): BookSummary => ({
  id,
  title: id,
  author: null,
  language: "en",
  languageSource: "detected",
  languageConfidence: 1,
  declaredLanguage: null,
  status: "converting",
  hasCover: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  chapterCount: 4,
  doneCount: 0,
  failedCount: 0,
  wordCount: 80,
  estimate: null,
  measuring: false,
  timeLeft: null,
  durationSeconds: 0,
  outputs: NO_OUTPUTS,
  ...overrides,
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
        held: false,
        services: [],
      }),
    ).toBe(before);
    expect(patchBook(before, { type: "book-added", bookId: "b1" })).toBe(before);
  });

  it("asks for a reload when the chapter is unknown", () => {
    expect(patchBook(book(), chapterEvent({ position: 9 }))).toBeNull();
  });

  it("keeps the old audio while a chapter is regenerated, and takes the new version when it lands", () => {
    const before = book({
      chapters: [
        chapter(1, {
          status: "done",
          progress: 1,
          durationSeconds: 12,
          hasAudio: true,
          audioVersion: 3,
        }),
        chapter(2),
        chapter(3),
      ],
    });

    const regenerating = patchBook(before, chapterEvent({ position: 1, status: "queued" }));
    const landed = patchBook(
      regenerating ?? before,
      chapterEvent({
        position: 1,
        status: "done",
        progress: 1,
        durationSeconds: 14,
        audioVersion: 4,
      }),
    );
    const first = patchBook(book(), chapterEvent({ position: 2, status: "done", audioVersion: 1 }));

    expect(regenerating?.chapters[0]).toMatchObject({
      status: "queued",
      hasAudio: true,
      audioVersion: 3,
    });
    expect(landed?.chapters[0]).toMatchObject({
      status: "done",
      audioVersion: 4,
      durationSeconds: 14,
    });
    expect(first?.chapters[1]).toMatchObject({ hasAudio: true, audioVersion: 1 });
  });

  it("shows a failed regeneration as a note on a chapter that is done again, and clears it", () => {
    const before = book({
      chapters: [
        chapter(1, { status: "queued", hasAudio: true, audioVersion: 2, durationSeconds: 9 }),
        chapter(2),
        chapter(3),
      ],
    });

    const failed = patchBook(
      before,
      chapterEvent({ position: 1, status: "done", progress: 1, regenError: "Engine down." }),
    );
    const again = patchBook(
      failed ?? before,
      chapterEvent({ position: 1, status: "queued", progress: 0 }),
    );

    expect(failed?.chapters[0]).toMatchObject({
      status: "done",
      regenError: "Engine down.",
      audioVersion: 2,
      durationSeconds: 9,
    });
    expect(failed).toMatchObject({ doneCount: 1, failedCount: 0 });
    expect(again?.chapters[0]).toMatchObject({ status: "queued", regenError: null });
  });

  it("takes the counts of a book event, and asks for a reload only when Convert changed the chapters", () => {
    const same: LiveEvent = {
      type: "book",
      bookId: "b1",
      status: "converting",
      doneCount: 2,
      failedCount: 1,
      durationSeconds: 75,
    };
    const changed: LiveEvent = { ...same, status: "done_with_errors" };

    expect(patchBook(book(), same)).toMatchObject({
      doneCount: 2,
      failedCount: 1,
      durationSeconds: 75,
    });
    expect(patchBook(book(), changed)).toMatchObject({ status: "done_with_errors", doneCount: 2 });
    expect(patchBook(book(), { ...same, status: "paused" })?.status).toBe("paused");
    expect(patchBook(book({ status: "paused" }), same)?.status).toBe("converting");
    expect(patchBook(book({ status: "ready" }), { ...same, status: "converting" })).toBeNull();
  });

  it("knows nothing more about a deleted book than the page does", () => {
    const before = book();

    expect(patchBook(before, { type: "book-deleted", bookId: "b1" })).toBe(before);
  });
});

describe("patchLibrary", () => {
  const bookEvent: LiveEvent = {
    type: "book",
    bookId: "b2",
    status: "done",
    doneCount: 4,
    failedCount: 0,
    durationSeconds: 240,
  };

  it("updates the status and counts of the book in the event", () => {
    const books = [summary("b1", { status: "done" }), summary("b2")];

    const after = patchLibrary(books, bookEvent);

    expect(after?.[1]).toMatchObject({ status: "done", doneCount: 4, durationSeconds: 240 });
    expect(after?.[0]).toBe(books[0]);
  });

  it("asks for a reload while a book is still converting, because its time left moved", () => {
    expect(patchLibrary([summary("b1"), summary("b2")], bookEvent)).toBeNull();
  });

  it("asks for a reload for a book it does not know and for a new book", () => {
    expect(patchLibrary([summary("b1")], bookEvent)).toBeNull();
    expect(patchLibrary([summary("b1")], { type: "book-added", bookId: "b3" })).toBeNull();
  });

  it("takes a deleted book out of the list, and keeps the list when it was not in it", () => {
    const books = [summary("b1"), summary("b2")];

    expect(patchLibrary(books, { type: "book-deleted", bookId: "b1" })).toEqual([books[1]]);
    expect(patchLibrary(books, { type: "book-deleted", bookId: "zzz" })).toBe(books);
  });

  it("leaves the list alone for chapter and pool events", () => {
    const books = [summary("b1")];

    expect(patchLibrary(books, chapterEvent())).toBe(books);
  });
});

const outputs = (overrides: Partial<Extract<LiveEvent, { type: "outputs" }>> = {}): LiveEvent => ({
  type: "outputs",
  bookId: "b1",
  state: "building",
  available: false,
  updating: true,
  progress: 0.5,
  error: null,
  m4bBytes: null,
  zipBytes: null,
  ...overrides,
});

describe("outputs events", () => {
  it("replaces the downloads state of the book it is about", () => {
    const after = patchBook(book({ status: "done" }), outputs());

    expect(after?.outputs).toEqual({
      state: "building",
      available: false,
      updating: true,
      progress: 0.5,
      error: null,
      m4bBytes: null,
      zipBytes: null,
    });
    expect(after?.status).toBe("done");
  });

  it("leaves other books alone", () => {
    const before = book();

    expect(patchBook(before, outputs({ bookId: "other" }))).toBe(before);
  });

  it("updates the library entry, and only that one", () => {
    const books = [summary("b1"), summary("b2")];

    const after = patchLibrary(
      books,
      outputs({ state: "ready", available: true, m4bBytes: 1, zipBytes: 2 }),
    );

    expect(after?.[0]?.outputs.available).toBe(true);
    expect(after?.[1]).toBe(books[1]);
  });
});

const poolEvent = (held: boolean): LiveEvent => ({
  type: "pool",
  state: "running",
  error: null,
  cause: null,
  workers: 2,
  activeWorkers: 0,
  held,
  services: [],
});

describe("patchLibrary while a book waits for the speed test", () => {
  const waiting = summary("b1", {
    timeLeft: {
      state: "waiting_for_speed_test",
      remainingSeconds: 100,
      speedTestSeconds: 60,
      booksAhead: 0,
      startsInSeconds: null,
      source: "benchmark",
    },
  });
  const benchmarkEvent: LiveEvent = {
    type: "benchmark",
    state: "running",
    trigger: "manual",
    progress: 0.5,
    language: "en",
    startedAt: null,
    outcome: null,
    error: null,
    expectedSeconds: 180,
  };

  it("asks again when the pool is let go, so the line stops saying it waits", () => {
    expect(patchLibrary([waiting], poolEvent(false))).toBeNull();
  });

  it("asks again as the test moves on, to keep the time it says current", () => {
    expect(patchLibrary([waiting], benchmarkEvent)).toBeNull();
  });

  it("leaves the list alone when no book waits for it, and while the pool is only being taken", () => {
    const books = [summary("b2")];

    expect(patchLibrary(books, poolEvent(false))).toBe(books);
    expect(patchLibrary(books, benchmarkEvent)).toBe(books);
    expect(patchLibrary([waiting], poolEvent(true))).toEqual([waiting]);
  });
});
