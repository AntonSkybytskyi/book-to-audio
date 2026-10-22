import type { SpeedModel, ThroughputPoint } from "../../shared/estimate.js";
import type { BenchmarkRepository, StoredBenchmark } from "../benchmark/repository.js";
import type { Voice } from "../tts/engine.js";
import type { LearningRepository } from "./learning.js";

/**
 * Used for a voice nobody has measured yet. Rough: the speech rate is what the three default
 * Piper voices gave on the development machine (docs/decisions/benchmark.md), the throughput
 * curve a typical shape for it. The estimates are marked as rough while these are in use.
 */
export const ROUGH_SECONDS_PER_KCHAR: Readonly<Record<string, number>> = {
  en: 57,
  uk: 58,
  ru: 65,
};
const ROUGH_DEFAULT_SECONDS_PER_KCHAR = 60;
const ROUGH_THROUGHPUT: readonly ThroughputPoint[] = [
  { workers: 1, audioPerSecond: 20 },
  { workers: 2, audioPerSecond: 26 },
  { workers: 4, audioPerSecond: 29 },
];
/**
 * Seconds a chapter costs besides reading it: preparing its text (45 ms for 21,000 characters), joining
 * the chunks (125 ms for 20 of them) and saving, measured in the container. The learned slowdown
 * covers whatever else a real chapter costs.
 */
export const CHAPTER_OVERHEAD_SECONDS = 0.3;
/** Real chapters needed before the estimate is called learned. */
const LEARNED_AFTER = 3;

export const roughModel = (language: string): SpeedModel => ({
  secondsPerKChar: ROUGH_SECONDS_PER_KCHAR[language] ?? ROUGH_DEFAULT_SECONDS_PER_KCHAR,
  throughput: [...ROUGH_THROUGHPUT],
  chapterOverheadSeconds: CHAPTER_OVERHEAD_SECONDS,
  slowdown: 1,
  source: "rough",
});

/** What the benchmark measured, and nothing learned since. */
export const benchmarkModel = (result: StoredBenchmark): SpeedModel => ({
  secondsPerKChar: result.secondsPerKChar,
  throughput: result.throughput,
  chapterOverheadSeconds: CHAPTER_OVERHEAD_SECONDS,
  slowdown: 1,
  source: "benchmark",
});

/**
 * The speed model of a voice: the benchmark of this computer if there is one, else rough defaults,
 * moved towards what real conversions showed (table `speed_learning`).
 */
export class SpeedCalibration {
  constructor(
    private readonly benchmarks: BenchmarkRepository,
    private readonly learning: LearningRepository,
  ) {}

  /** Before anything was learned: the benchmark if there is one, else the rough defaults. */
  baseModel(engineId: string, voice: Pick<Voice, "id" | "language">): SpeedModel {
    const measured = this.benchmarks.get(engineId, voice.id);
    return measured ? benchmarkModel(measured) : roughModel(voice.language);
  }

  modelFor(engineId: string, voice: Pick<Voice, "id" | "language">): SpeedModel {
    const base = this.baseModel(engineId, voice);
    const learned = this.learning.get(engineId, voice.id);
    if (!learned) return base;
    return {
      ...base,
      secondsPerKChar: learned.secondsPerKChar,
      slowdown: learned.slowdown,
      source: learned.samples >= LEARNED_AFTER ? "learned" : base.source,
    };
  }
}
