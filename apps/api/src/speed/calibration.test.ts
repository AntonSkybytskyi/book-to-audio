import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BenchmarkRepository, type VoiceMeasurement } from "../benchmark/repository.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import {
  CHAPTER_OVERHEAD_SECONDS,
  roughModel,
  SpeedCalibration,
  ROUGH_SECONDS_PER_KCHAR,
} from "./calibration.js";
import { LearningRepository } from "./learning.js";
import { SpeedLearning } from "./learner.js";

const voice = { id: "v-en", language: "en" };

const measured: VoiceMeasurement = {
  engine: "e",
  voiceId: "v-en",
  language: "en",
  secondsPerKChar: 55,
  rtf: 0.05,
  encodeFactor: 0.01,
  modelLoadMs: 300,
  throughput: [
    { workers: 1, audioPerSecond: 20 },
    { workers: 2, audioPerSecond: 30 },
  ],
  sampleChars: 1000,
  sampleAudioSeconds: 55,
};

describe("speed calibration and learning", () => {
  let ctx: TestContext;
  let benchmarks: BenchmarkRepository;
  let learning: LearningRepository;
  let calibration: SpeedCalibration;

  beforeEach(() => {
    ctx = createTestContext();
    benchmarks = new BenchmarkRepository(ctx.db);
    learning = new LearningRepository(ctx.db);
    calibration = new SpeedCalibration(benchmarks, learning);
  });

  afterEach(() => ctx.cleanup());

  const learner = () => new SpeedLearning(calibration, learning);
  const benchmarkIt = () =>
    benchmarks.save([measured], { cpuCount: 8, cpuModel: "cpu" }, 3, "2026-01-01T00:00:00Z");

  describe("SpeedCalibration", () => {
    it("falls back to rough defaults for a voice nobody measured, and says so", () => {
      const model = calibration.modelFor("e", voice);

      expect(model.source).toBe("rough");
      expect(model.secondsPerKChar).toBe(ROUGH_SECONDS_PER_KCHAR.en);
      expect(model.slowdown).toBe(1);
      expect(model).toEqual(roughModel("en"));
    });

    it("has a default for a language it knows nothing about", () => {
      expect(roughModel("de").secondsPerKChar).toBeGreaterThan(0);
    });

    it("uses what the benchmark measured", () => {
      benchmarkIt();

      const model = calibration.modelFor("e", voice);

      expect(model).toMatchObject({
        source: "benchmark",
        secondsPerKChar: 55,
        slowdown: 1,
        throughput: measured.throughput,
      });
    });

    it("keeps the results of one engine apart from another's", () => {
      benchmarkIt();

      expect(calibration.modelFor("other", voice).source).toBe("rough");
    });

    it("moves to what was learned, but calls it learned only after a few chapters", () => {
      benchmarkIt();
      learning.save("e", "v-en", { secondsPerKChar: 50, slowdown: 1.3, samples: 2 });
      expect(calibration.modelFor("e", voice)).toMatchObject({
        source: "benchmark",
        secondsPerKChar: 50,
        slowdown: 1.3,
      });

      learning.save("e", "v-en", { secondsPerKChar: 50, slowdown: 1.3, samples: 3 });
      expect(calibration.modelFor("e", voice).source).toBe("learned");
    });

    it("learns on top of the rough defaults when there is no benchmark, still calling it rough until enough", () => {
      learning.save("e", "v-en", { secondsPerKChar: 52, slowdown: 0.9, samples: 1 });

      expect(calibration.modelFor("e", voice)).toMatchObject({
        source: "rough",
        secondsPerKChar: 52,
        slowdown: 0.9,
      });
    });

    it("forgets what was learned when the voice is benchmarked again", () => {
      learning.save("e", "v-en", { secondsPerKChar: 50, slowdown: 1.3, samples: 9 });

      benchmarkIt();

      expect(learning.get("e", "v-en")).toBeUndefined();
      expect(calibration.modelFor("e", voice).slowdown).toBe(1);
    });
  });

  describe("SpeedLearning", () => {
    const chapter = {
      engine: "e",
      voiceId: "v-en",
      language: "en",
      preparedChars: 10_000,
      durationSeconds: 550, // 55 s per 1,000 characters, as measured
      wallSeconds: 27.5 + CHAPTER_OVERHEAD_SECONDS, // exactly what the benchmark predicts: 550 / 20 plus the overhead
      concurrency: 1,
    };

    it("learns nothing new from a chapter that went exactly as the benchmark said", () => {
      benchmarkIt();

      learner().recordChapter(chapter);

      const learned = learning.get("e", "v-en");
      expect(learned?.samples).toBe(1);
      expect(learned?.slowdown).toBeCloseTo(1, 6);
      expect(learned?.secondsPerKChar).toBeCloseTo(55, 6);
    });

    it("notices a machine that is slower than it was at the benchmark", () => {
      benchmarkIt();

      for (let i = 0; i < 20; i++)
        learner().recordChapter({ ...chapter, wallSeconds: 2 * (27.5 + CHAPTER_OVERHEAD_SECONDS) });

      expect(learning.get("e", "v-en")?.slowdown).toBeCloseTo(2, 1);
      expect(calibration.modelFor("e", voice).source).toBe("learned");
    });

    it("compares a chapter with the benchmark at the number of workers that were busy", () => {
      benchmarkIt();
      // Two workers make 30 audio s/s together, so each does 15: 550 s of audio takes 36.7 s plus the overhead.
      const wall = 550 / 15 + CHAPTER_OVERHEAD_SECONDS / 0.75;

      learner().recordChapter({ ...chapter, concurrency: 2, wallSeconds: wall });

      expect(learning.get("e", "v-en")?.slowdown).toBeCloseTo(1, 6);
    });

    it("moves the speech rate towards what the chapters showed", () => {
      benchmarkIt();

      for (let i = 0; i < 30; i++) {
        learner().recordChapter({ ...chapter, durationSeconds: 650, wallSeconds: 34 });
      }

      expect(learning.get("e", "v-en")?.secondsPerKChar).toBeCloseTo(65, 1);
    });

    it("moves half way on the first chapter and does not jump to it", () => {
      benchmarkIt();

      learner().recordChapter({ ...chapter, durationSeconds: 650, wallSeconds: 34 });

      expect(learning.get("e", "v-en")?.secondsPerKChar).toBeCloseTo(60, 6);
    });

    it("limits what one odd chapter can do", () => {
      benchmarkIt();

      learner().recordChapter({ ...chapter, wallSeconds: 100_000 });

      // At most twice what it was (1), and then only half way there.
      expect(learning.get("e", "v-en")?.slowdown).toBeCloseTo(1.5, 6);
    });

    it("is not thrown off by a first chapter that was an outlier: the next normal ones pull it back", () => {
      benchmarkIt();
      const normal = 27.5 + CHAPTER_OVERHEAD_SECONDS;

      learner().recordChapter({ ...chapter, wallSeconds: normal * 4 }); // a stall: 4 times too slow
      const after = learning.get("e", "v-en")?.slowdown ?? 0;
      for (let i = 0; i < 6; i++) learner().recordChapter({ ...chapter, wallSeconds: normal });

      expect(after).toBeLessThanOrEqual(1.5);
      expect(learning.get("e", "v-en")?.slowdown).toBeLessThan(1.2);
    });

    it("keeps the learned speech rate within a band around the benchmark's", () => {
      benchmarkIt();

      for (let i = 0; i < 40; i++) {
        learner().recordChapter({ ...chapter, durationSeconds: 5500, wallSeconds: 300 }); // 10 times slower speech
      }

      expect(learning.get("e", "v-en")?.secondsPerKChar).toBeCloseTo(55 * 1.25, 2);
    });

    it("works without a benchmark, against the rough defaults", () => {
      learner().recordChapter({ ...chapter, wallSeconds: 60 });

      expect(learning.get("e", "v-en")).toMatchObject({ samples: 1 });
    });

    it("ignores chapters too short to say anything, and impossible numbers", () => {
      benchmarkIt();

      learner().recordChapter({ ...chapter, durationSeconds: 5 });
      learner().recordChapter({ ...chapter, wallSeconds: 0 });
      learner().recordChapter({ ...chapter, preparedChars: 0 });

      expect(learning.get("e", "v-en")).toBeUndefined();
    });

    it("keeps each voice apart", () => {
      benchmarkIt();

      learner().recordChapter({ ...chapter, voiceId: "v-other", wallSeconds: 90 });

      expect(learning.get("e", "v-en")).toBeUndefined();
      expect(learning.get("e", "v-other")?.samples).toBe(1);
    });
  });
});
