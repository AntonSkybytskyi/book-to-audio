import { describe, expect, it } from "vitest";
import type { SpeedModel } from "@book-to-audio/contracts";
import type { BookLoad, ChapterLoad } from "../books/repository.js";
import { FakeEngine } from "../tts/fake.js";
import type { SpeedCalibration } from "./calibration.js";
import { Estimator } from "./estimator.js";

const model = (overrides: Partial<SpeedModel> = {}): SpeedModel => ({
  secondsPerKChar: 60,
  throughput: [{ workers: 1, audioPerSecond: 20 }],
  chapterOverheadSeconds: 0,
  slowdown: 1,
  source: "benchmark",
  ...overrides,
});

const chapter = (
  status: ChapterLoad["status"],
  preparedChars = 1000,
  progress = 0,
): ChapterLoad => ({ status, preparedChars, progress, counted: true });

const book = (
  bookId: string,
  status: BookLoad["status"],
  chapters: ChapterLoad[],
  language = "en",
): BookLoad => ({ bookId, language, status, chapters });

const engine = new FakeEngine({
  voices: [
    { id: "v-en", language: "en", name: "En", sampleRate: 22_050 },
    { id: "v-uk", language: "uk", name: "Uk", sampleRate: 22_050 },
  ],
});

const make = (
  options: {
    workers?: number;
    paused?: boolean;
    models?: Record<string, SpeedModel>;
    speedTest?: number | null;
  } = {},
) => {
  const models = options.models ?? { "v-en": model(), "v-uk": model({ secondsPerKChar: 100 }) };
  const calibration = {
    modelFor: (_engine: string, voice: { id: string }) => models[voice.id] ?? model(),
  } as unknown as SpeedCalibration;
  return new Estimator({
    engine,
    calibration,
    workers: () => options.workers ?? 1,
    poolPaused: () => options.paused ?? false,
    speedTestSeconds: () => options.speedTest ?? null,
  });
};

describe("Estimator", () => {
  describe("the length and conversion time of a book", () => {
    it("is the prepared characters times the speech rate, and the time is the audio over the speed", () => {
      const estimates = make().forBooks([
        book("a", "ready", [chapter("pending", 3000), chapter("pending", 2000)]),
      ]);

      const { estimate } = estimates.get("a")!;
      expect(estimate.audioSeconds).toBe(300); // 5,000 characters at 60 s per 1,000
      expect(estimate.convertSeconds).toBe(15); // 300 s of audio at 20 audio s/s
      expect(estimate.source).toBe("benchmark");
      expect(estimate.workers).toBe(1);
    });

    it("uses the speech rate of the book's own language", () => {
      const estimates = make().forBooks([
        book("en", "ready", [chapter("pending")], "en"),
        book("uk", "ready", [chapter("pending")], "uk"),
      ]);

      expect(estimates.get("en")?.estimate.audioSeconds).toBe(60);
      expect(estimates.get("uk")?.estimate.audioSeconds).toBe(100);
    });

    it("is faster with more workers, by the measured throughput", () => {
      const fast = model({
        throughput: [
          { workers: 1, audioPerSecond: 20 },
          { workers: 2, audioPerSecond: 30 },
        ],
      });
      const load = [book("a", "ready", [chapter("pending", 2000), chapter("pending", 2000)])];

      const one = make({ workers: 1, models: { "v-en": fast } })
        .forBooks(load)
        .get("a")!;
      const two = make({ workers: 2, models: { "v-en": fast } })
        .forBooks(load)
        .get("a")!;

      expect(one.estimate.convertSeconds).toBe(12);
      expect(two.estimate.convertSeconds).toBe(8);
      expect(two.estimate.workers).toBe(2);
    });

    it("reports the source of the speed, so rough guesses can be marked", () => {
      const estimates = make({ models: { "v-en": model({ source: "rough" }) } }).forBooks([
        book("a", "ready", [chapter("pending")]),
      ]);

      expect(estimates.get("a")?.estimate.source).toBe("rough");
    });

    it("has no estimate for a book whose language has no voice", () => {
      const estimates = make().forBooks([book("a", "ready", [chapter("pending")], "ru")]);

      expect(estimates.has("a")).toBe(false);
    });

    it("counts the chapters that are done in the whole book, as the preview of a converted one would", () => {
      const estimates = make().forBooks([
        book("a", "converting", [chapter("done", 1000), chapter("queued", 1000)]),
      ]);

      expect(estimates.get("a")?.estimate.audioSeconds).toBe(120);
    });

    it("keeps the learned slowdown in the conversion time but not in the audio length", () => {
      const slow = make({ models: { "v-en": model({ slowdown: 2 }) } }).forBooks([
        book("a", "ready", [chapter("pending", 1000)]),
      ]);

      expect(slow.get("a")?.estimate.audioSeconds).toBe(60);
      expect(slow.get("a")?.estimate.convertSeconds).toBe(6);
    });
  });

  describe("the time left", () => {
    it("is not given for a book that is not converting", () => {
      const estimates = make().forBooks([book("a", "ready", [chapter("pending")])]);

      expect(estimates.get("a")?.timeLeft).toBeNull();
    });

    it("counts the chapters still to read, and a running one by what is left of it", () => {
      const estimates = make().forBooks([
        book("a", "converting", [
          chapter("done", 1000),
          chapter("generating", 1000, 0.5),
          chapter("queued", 1000),
        ]),
      ]);

      // 30 s left of the running one and 60 s of the queued one, at 20 audio s/s.
      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "running",
        remainingSeconds: 4.5,
        booksAhead: 0,
        startsInSeconds: null,
      });
    });

    it("leaves out failed chapters", () => {
      const estimates = make().forBooks([
        book("a", "converting", [chapter("failed", 5000), chapter("queued", 1000)]),
      ]);

      expect(estimates.get("a")?.timeLeft?.remainingSeconds).toBe(3);
    });

    it("says paused, with no number, for a paused book", () => {
      const estimates = make().forBooks([book("a", "paused", [chapter("queued")])]);

      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "paused",
        remainingSeconds: null,
      });
    });

    it("says paused, with no number, for every converting book while the pool is paused", () => {
      const estimates = make({ paused: true }).forBooks([
        book("a", "converting", [chapter("queued")]),
        book("b", "converting", [chapter("queued")]),
      ]);

      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "pool_paused",
        remainingSeconds: null,
      });
      expect(estimates.get("b")?.timeLeft).toMatchObject({
        state: "pool_paused",
        remainingSeconds: null,
        startsInSeconds: null,
      });
    });

    it("has the book wait for the books queued before it, and says for how long", () => {
      const estimates = make().forBooks([
        book("first", "converting", [chapter("generating", 1000, 0), chapter("queued", 1000)]),
        book("second", "converting", [chapter("queued", 1000)]),
        book("third", "converting", [chapter("queued", 2000)]),
      ]);

      expect(estimates.get("first")?.timeLeft).toMatchObject({ state: "running", booksAhead: 0 });
      expect(estimates.get("second")?.timeLeft).toMatchObject({
        state: "waiting",
        booksAhead: 1,
        startsInSeconds: 6, // all of the first book's 120 s of audio
        remainingSeconds: 3,
      });
      expect(estimates.get("third")?.timeLeft).toMatchObject({
        state: "waiting",
        booksAhead: 2,
        startsInSeconds: 9,
        remainingSeconds: 6,
      });
    });

    it("does not wait behind a paused book, which takes no worker", () => {
      const estimates = make().forBooks([
        book("paused", "paused", [chapter("queued", 9000)]),
        book("next", "converting", [chapter("queued", 1000)]),
      ]);

      expect(estimates.get("next")?.timeLeft).toMatchObject({ state: "running", booksAhead: 0 });
    });

    it("is not waiting once a chapter of the book is being read", () => {
      const estimates = make({ workers: 2 }).forBooks([
        book("first", "converting", [chapter("queued", 1000)]),
        book("second", "converting", [chapter("generating", 1000, 0.5), chapter("queued", 1000)]),
      ]);

      expect(estimates.get("second")?.timeLeft).toMatchObject({
        state: "running",
        booksAhead: 0,
        startsInSeconds: null,
      });
    });

    it("does not count a book ahead that has nothing left to read", () => {
      const estimates = make().forBooks([
        book("finishing", "converting", [chapter("done"), chapter("failed")]),
        book("next", "converting", [chapter("queued", 1000)]),
      ]);

      expect(estimates.get("next")?.timeLeft?.booksAhead).toBe(0);
    });

    it("uses each book's own voice for the wait, and the learned slowdown", () => {
      const estimates = make({
        models: {
          "v-en": model({ slowdown: 2 }),
          "v-uk": model({ secondsPerKChar: 100 }),
        },
      }).forBooks([
        book("uk", "converting", [chapter("queued", 1000)], "uk"),
        book("en", "converting", [chapter("queued", 1000)], "en"),
      ]);

      expect(estimates.get("en")?.timeLeft).toMatchObject({
        startsInSeconds: 5,
        remainingSeconds: 6,
      });
    });
  });

  describe("while the pool is held for the speed test", () => {
    it("says the book waits for the speed test, and for how long, once its chapters have finished", () => {
      const estimates = make({ speedTest: 150 }).forBooks([
        book("a", "converting", [chapter("done"), chapter("queued", 1000)]),
      ]);

      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "waiting_for_speed_test",
        speedTestSeconds: 150,
        remainingSeconds: 3, // what it needs after the test
      });
    });

    it("says running while one of its chapters is still being read, as nothing is held up yet", () => {
      const estimates = make({ speedTest: 150 }).forBooks([
        book("a", "converting", [chapter("generating", 1000, 0.5), chapter("queued", 1000)]),
      ]);

      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "running",
        speedTestSeconds: null,
      });
    });

    it("leaves a paused book and a paused pool as they are", () => {
      const load = [book("a", "converting", [chapter("queued", 1000)])];

      expect(
        make({ speedTest: 150, paused: true }).forBooks(load).get("a")?.timeLeft,
      ).toMatchObject({
        state: "pool_paused",
        speedTestSeconds: null,
      });
      expect(
        make({ speedTest: 150 })
          .forBooks([book("a", "paused", [chapter("queued", 1000)])])
          .get("a")?.timeLeft,
      ).toMatchObject({ state: "paused", speedTestSeconds: null });
    });

    it("says nothing about a speed test when none holds the pool", () => {
      const estimates = make().forBooks([book("a", "converting", [chapter("queued", 1000)])]);

      expect(estimates.get("a")?.timeLeft).toMatchObject({
        state: "running",
        speedTestSeconds: null,
      });
    });
  });

  describe("measuring", () => {
    it("is true while some chapter has no count, and then the estimate stands on raw lengths", () => {
      const estimates = make().forBooks([
        book("a", "ready", [chapter("pending"), { ...chapter("pending"), counted: false }]),
        book("b", "ready", [chapter("pending")]),
      ]);

      expect(estimates.get("a")?.measuring).toBe(true);
      expect(estimates.get("b")?.measuring).toBe(false);
    });
  });

  describe("a book that is not queued yet", () => {
    it("tells where it would stand: behind every book that is converting, not the paused ones", () => {
      const estimates = make().forBooks([
        book("running", "converting", [chapter("queued", 1000)]),
        book("paused", "paused", [chapter("queued", 1000)]),
        book("new", "ready", [chapter("pending", 1000)]),
      ]);

      expect(estimates.get("new")?.estimate.queue).toEqual({ booksAhead: 1, startsInSeconds: 3 });
    });

    it("has nobody ahead when nothing is converting", () => {
      const estimates = make().forBooks([book("new", "ready", [chapter("pending")])]);

      expect(estimates.get("new")?.estimate.queue).toEqual({
        booksAhead: 0,
        startsInSeconds: null,
      });
    });

    it("cannot say when it would start while all conversion is paused", () => {
      const estimates = make({ paused: true }).forBooks([
        book("running", "converting", [chapter("queued", 1000)]),
        book("new", "ready", [chapter("pending", 1000)]),
      ]);

      expect(estimates.get("new")?.estimate.queue).toEqual({
        booksAhead: 1,
        startsInSeconds: null,
      });
    });
  });

  describe("another language for the preview", () => {
    it("reads the book as if it were in that language, with the character counts given for it", () => {
      const estimates = make().forBooks(
        [book("a", "ready", [chapter("pending", 1000), chapter("pending", 1000)], "en")],
        { bookId: "a", language: "uk", chars: [2000, 3000] },
      );

      expect(estimates.get("a")?.estimate.audioSeconds).toBe(500); // 5,000 characters at 100 s per 1,000
    });

    it("leaves the other books as they are", () => {
      const estimates = make().forBooks(
        [
          book("a", "ready", [chapter("pending", 1000)], "en"),
          book("b", "ready", [chapter("pending", 1000)], "en"),
        ],
        { bookId: "a", language: "uk", chars: [2000] },
      );

      expect(estimates.get("b")?.estimate.audioSeconds).toBe(60);
    });
  });

  describe("modelFor", () => {
    it("is null for a language with no voice", () => {
      expect(make().modelFor("ru")).toBeNull();
      expect(make().modelFor("en")).not.toBeNull();
    });
  });
});
