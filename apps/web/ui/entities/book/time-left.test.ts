import { describe, expect, it } from "vitest";
import type { Book, BookEstimate, BookSummary, Chapter, TimeLeft } from "./api";
import type { PoolStatus } from "@/ui/entities/pool/api";
import type { SpeedModel } from "@book-to-audio/contracts";
import { NO_OUTPUTS } from "./api";
import {
  bookTimeLeft,
  chapterLength,
  leftPhrase,
  libraryTimeLeft,
  previewText,
  remainingNow,
} from "./time-left";

const speed: SpeedModel = {
  secondsPerKChar: 60,
  throughput: [{ workers: 1, audioPerSecond: 20 }],
  chapterOverheadSeconds: 0,
  slowdown: 1,
  source: "benchmark",
};

const chapter = (position: number, overrides: Partial<Chapter> = {}): Chapter => ({
  position,
  title: `C${position}`,
  status: "queued",
  progress: 0,
  error: null,
  charCount: 1000,
  wordCount: 100,
  preparedChars: 1000,
  estimatedSeconds: 60,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
  hasAudio: false,
  audioVersion: 0,
  regenError: null,
  ...overrides,
});

const timeLeft = (overrides: Partial<TimeLeft> = {}): TimeLeft => ({
  state: "running",
  remainingSeconds: 600,
  booksAhead: 0,
  startsInSeconds: null,
  speedTestSeconds: null,
  source: "benchmark",
  ...overrides,
});

const summary = (overrides: Partial<BookSummary> = {}): BookSummary => ({
  id: "b",
  title: "T",
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
  wordCount: 300,
  estimate: null,
  measuring: false,
  timeLeft: timeLeft(),
  durationSeconds: 0,
  outputs: NO_OUTPUTS,
  ...overrides,
});

const book = (overrides: Partial<Book> = {}): Book => ({
  ...summary(),
  speed,
  chapters: [chapter(1), chapter(2), chapter(3)],
  availableLanguages: ["en"],
  ...overrides,
});

const pool = (overrides: Partial<PoolStatus> = {}): PoolStatus => ({
  state: "running",
  error: null,
  cause: null,
  workers: 1,
  activeWorkers: 1,
  held: false,
  ...overrides,
});

describe("leftPhrase", () => {
  it("rounds sensibly and says less than a minute at the end", () => {
    expect(leftPhrase(8100)).toBe("about 2 h 15 min left");
    expect(leftPhrase(200)).toBe("about 3 min left");
    expect(leftPhrase(40)).toBe("less than a minute left");
  });
});

describe("remainingNow", () => {
  it("is worked out from the chapters as they are now, so it counts down while a chapter runs", () => {
    // 60 s of audio per chapter at 20 audio s/s: 3 s each.
    expect(remainingNow(book(), 1)).toBeCloseTo(9);
    const running = book({
      chapters: [chapter(1, { status: "generating", progress: 0.5 }), chapter(2), chapter(3)],
    });
    expect(remainingNow(running, 1)).toBeCloseTo(7.5);
    const done = book({
      chapters: [chapter(1, { status: "done", progress: 1 }), chapter(2), chapter(3)],
    });
    expect(remainingNow(done, 1)).toBeCloseTo(6);
  });

  it("leaves out failed chapters", () => {
    const failed = book({ chapters: [chapter(1, { status: "failed" }), chapter(2)] });

    expect(remainingNow(failed, 1)).toBeCloseTo(3);
  });

  it("takes the worker count into account", () => {
    const fast = book({
      speed: {
        ...speed,
        throughput: [
          { workers: 1, audioPerSecond: 20 },
          { workers: 3, audioPerSecond: 54 },
        ],
      },
    });

    expect(remainingNow(fast, 3)).toBeLessThan(remainingNow(fast, 1) ?? 0);
  });

  it("falls back to the server's number when there is no speed", () => {
    const fallback = book({ speed: null, timeLeft: timeLeft({ remainingSeconds: 321 }) });

    expect(remainingNow(fallback, 1)).toBe(321);
    expect(remainingNow(book({ speed: null, timeLeft: null }), 1)).toBeNull();
  });
});

describe("bookTimeLeft", () => {
  it("says nothing for a book that is not being converted", () => {
    expect(bookTimeLeft(book({ status: "done", timeLeft: null }), pool())).toBeNull();
    expect(bookTimeLeft(book({ status: "ready", timeLeft: null }), pool())).toBeNull();
  });

  it("gives the time left of a converting book, from the chapters as they are", () => {
    const long = book({ chapters: [chapter(1, { preparedChars: 360_000 })] });

    // 21,600 s of audio at 20 audio s/s: 18 minutes.
    expect(bookTimeLeft(long, pool())).toBe("About 20 min left.");
  });

  it("marks an estimate that is only a rough guess", () => {
    const text = bookTimeLeft(book({ timeLeft: timeLeft({ source: "rough" }) }), pool());

    expect(text).toBe("Less than a minute left (rough estimate).");
  });

  it("says paused, with no number, for a paused book", () => {
    const paused = book({ status: "paused", timeLeft: timeLeft({ state: "paused" }) });

    const text = bookTimeLeft(paused, pool());

    expect(text).toMatch(/^Time left: paused/);
    expect(text).not.toMatch(/\d/);
  });

  it("says paused, with no number, while all conversion is paused, from the live state or the server's", () => {
    expect(bookTimeLeft(book(), pool({ state: "paused" }))).toMatch(/all conversion is paused/);
    expect(bookTimeLeft(book({ timeLeft: timeLeft({ state: "pool_paused" }) }), pool())).toMatch(
      /all conversion is paused/,
    );
  });

  it("says when a book waiting in the queue starts, and what comes after", () => {
    const waiting = book({
      timeLeft: timeLeft({ state: "waiting", booksAhead: 2, startsInSeconds: 3600 }),
      chapters: [chapter(1, { preparedChars: 360_000 })],
    });

    expect(bookTimeLeft(waiting, pool())).toBe(
      "Starts after 2 books, in about 1 h. Then about 20 min.",
    );
  });

  it("says one book, not 1 books", () => {
    const waiting = book({
      timeLeft: timeLeft({ state: "waiting", booksAhead: 1, startsInSeconds: null }),
    });

    expect(bookTimeLeft(waiting, pool())).toMatch(/^Starts after 1 book\./);
  });

  it("says how long the speed test is expected to take, and what is left after it", () => {
    const held = book({ chapters: [chapter(1, { preparedChars: 360_000 })] });

    expect(bookTimeLeft(held, pool({ held: true, activeWorkers: 0 }), 120)).toBe(
      "Waiting for a speed test (about 2 min), then about 20 min left.",
    );
  });

  it("falls back to the figure the server gave, and to no figure at all", () => {
    const held = book({
      timeLeft: timeLeft({ state: "waiting_for_speed_test", speedTestSeconds: 300 }),
    });

    expect(bookTimeLeft(held, pool({ held: true, activeWorkers: 0 }))).toMatch(
      /^Waiting for a speed test \(about 5 min\), then /,
    );
    expect(bookTimeLeft(book(), pool({ held: true, activeWorkers: 0 }))).toMatch(
      /^Waiting for a speed test, then /,
    );
  });

  it("follows the server's word when the page has no pool state yet", () => {
    const held = book({
      timeLeft: timeLeft({ state: "waiting_for_speed_test", speedTestSeconds: 90 }),
    });

    expect(bookTimeLeft(held, null)).toMatch(/^Waiting for a speed test \(about 2 min\)/);
  });

  it("does not say it is waiting for the speed test while a chapter is being read", () => {
    const reading = book({ chapters: [chapter(1, { status: "generating" }), chapter(2)] });

    expect(bookTimeLeft(reading, pool({ held: true }))).not.toMatch(/speed test/);
  });

  it("uses the worker count of the live pool, not the one the page loaded with", () => {
    const wide = book({
      speed: {
        ...speed,
        throughput: [
          { workers: 1, audioPerSecond: 1 },
          { workers: 4, audioPerSecond: 4 },
        ],
      },
      chapters: Array.from({ length: 4 }, (_, i) => chapter(i + 1, { preparedChars: 60_000 })),
    });

    expect(bookTimeLeft(wide, pool({ workers: 1 }))).toBe(bookTimeLeft(wide, pool({ workers: 1 })));
    // Four workers scale perfectly here, so they take a quarter of the time of one.
    expect(remainingNow(wide, 4)).toBeCloseTo((remainingNow(wide, 1) ?? 0) / 4);
    expect(bookTimeLeft(wide, pool({ workers: 1 }))).not.toBe(
      bookTimeLeft(wide, pool({ workers: 4 })),
    );
  });
});

const waitingSummary = (startsInSeconds: number | null, booksAhead: number) =>
  summary({
    timeLeft: timeLeft({
      state: "waiting",
      booksAhead,
      startsInSeconds,
      remainingSeconds: 1800,
    }),
  });

describe("libraryTimeLeft", () => {
  it("gives the time left of a converting book", () => {
    expect(
      libraryTimeLeft(summary({ timeLeft: timeLeft({ remainingSeconds: 5400 }) }), false),
    ).toBe("about 1 h 30 min left");
  });

  it("marks a rough estimate", () => {
    expect(libraryTimeLeft(summary({ timeLeft: timeLeft({ source: "rough" }) }), false)).toBe(
      "about 10 min left (rough estimate)",
    );
  });

  it("says paused for a paused book and for every book while the pool is paused", () => {
    const paused = summary({ timeLeft: timeLeft({ state: "paused", remainingSeconds: null }) });
    const poolPaused = summary({
      timeLeft: timeLeft({ state: "pool_paused", remainingSeconds: null }),
    });

    expect(libraryTimeLeft(paused, false)).toBe("time left paused");
    expect(libraryTimeLeft(summary(), true)).toBe("time left paused");
    expect(libraryTimeLeft(poolPaused, false)).toBe("time left paused");
  });

  it("says when a waiting book starts and how long it takes then", () => {
    expect(libraryTimeLeft(waitingSummary(3600, 2), false)).toBe(
      "starts in about 1 h, then about 30 min",
    );
    expect(libraryTimeLeft(waitingSummary(null, 1), false)).toBe(
      "starts after 1 book, then about 30 min",
    );
  });

  it("says a waiting book is waiting for the speed test, with the time it needs after", () => {
    const held = summary({
      timeLeft: timeLeft({
        state: "waiting_for_speed_test",
        speedTestSeconds: 120,
        remainingSeconds: 180,
      }),
    });

    expect(libraryTimeLeft(held, false)).toBe(
      "waiting for a speed test (about 2 min), then about 3 min left",
    );
  });

  it("says nothing for a book without a time left", () => {
    expect(libraryTimeLeft(summary({ timeLeft: null }), false)).toBeNull();
    expect(
      libraryTimeLeft(summary({ timeLeft: timeLeft({ remainingSeconds: null }) }), false),
    ).toBeNull();
  });
});

const estimate = (overrides: Partial<BookEstimate> = {}): BookEstimate => ({
  audioSeconds: 10 * 3600 + 20 * 60,
  convertSeconds: 2 * 3600 + 15 * 60,
  source: "benchmark",
  workers: 4,
  queue: { booksAhead: 0, startsInSeconds: null },
  ...overrides,
});

describe("previewText", () => {
  it("says how long the book is and how long converting takes on this computer", () => {
    expect(previewText(estimate())).toEqual({
      audio: "About 10 h 20 min of audio",
      convert: "converting takes about 2 h 15 min on this computer with 4 workers",
      queue: null,
      rough: false,
    });
  });

  it("says one worker, not 1 workers", () => {
    expect(previewText(estimate({ workers: 1 })).convert).toMatch(/with 1 worker$/);
  });

  it("handles very short books", () => {
    const text = previewText(estimate({ audioSeconds: 30, convertSeconds: 2 }));

    expect(text.audio).toBe("Under a minute of audio");
    expect(text.convert).toBe("converting takes under a minute on this computer with 4 workers");
  });

  it("says when it would start if other books are converting first", () => {
    const text = previewText(estimate({ queue: { booksAhead: 2, startsInSeconds: 3600 } }));

    expect(text.queue).toBe(
      "Other books are converting first: this one would start after 2 books, in about 1 h.",
    );
  });

  it("does not guess the wait while conversion is paused", () => {
    const text = previewText(estimate({ queue: { booksAhead: 1, startsInSeconds: null } }));

    expect(text.queue).toBe("Other books are converting first: this one would start after 1 book.");
  });

  it("flags a rough estimate", () => {
    expect(previewText(estimate({ source: "rough" })).rough).toBe(true);
    expect(previewText(estimate({ source: "learned" })).rough).toBe(false);
  });
});

describe("chapterLength", () => {
  it("is empty without an estimate and rounds the rest", () => {
    expect(chapterLength(null)).toBeNull();
    expect(chapterLength(20)).toBe("under a minute");
    expect(chapterLength(12 * 60)).toBe("10 min");
  });
});
