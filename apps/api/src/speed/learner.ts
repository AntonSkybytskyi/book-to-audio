import { chapterWallSeconds, clamp, ewma, SLOWDOWN_LIMITS } from "@book-to-audio/contracts";
import type { ChapterTiming, SpeedLearner } from "../convert/pool-types.js";
import type { SpeedCalibration } from "./calibration.js";
import type { LearningRepository } from "./learning.js";

/** Shorter chapters say more about the fixed cost of a chapter than about the voice. */
const MIN_AUDIO_SECONDS = 20;
/** One chapter moves the slowdown by at most this factor of what it is now, so an outlier cannot swing it. */
const STEP_LIMITS = { min: 0.5, max: 2 } as const;
/** The learned speech rate stays within this band around the benchmark's: a voice does not change speed by half. */
const RATE_BAND = { min: 0.75, max: 1.25 } as const;

/**
 * After each finished chapter, moves the voice's speech rate and its slowdown (how much slower the
 * chapters ran than the model at the same number of busy workers said) towards what was seen.
 */
export class SpeedLearning implements SpeedLearner {
  constructor(
    private readonly calibration: SpeedCalibration,
    private readonly learning: LearningRepository,
  ) {}

  recordChapter(timing: ChapterTiming): void {
    const { engine, voiceId, language, preparedChars, durationSeconds, wallSeconds, concurrency } =
      timing;
    if (durationSeconds < MIN_AUDIO_SECONDS || preparedChars <= 0 || wallSeconds <= 0) return;
    const base = this.calibration.baseModel(engine, { id: voiceId, language });
    const before = this.learning.get(engine, voiceId) ?? {
      secondsPerKChar: base.secondsPerKChar,
      slowdown: 1,
      samples: 0,
    };
    const predicted = chapterWallSeconds(base, durationSeconds, concurrency);
    const slowdown = clamp(
      clamp(wallSeconds / predicted, SLOWDOWN_LIMITS.min, SLOWDOWN_LIMITS.max),
      before.slowdown * STEP_LIMITS.min,
      before.slowdown * STEP_LIMITS.max,
    );
    const band = [
      base.secondsPerKChar * RATE_BAND.min,
      base.secondsPerKChar * RATE_BAND.max,
    ] as const;
    const rate = clamp(durationSeconds / (preparedChars / 1000), ...band);
    this.learning.save(engine, voiceId, {
      secondsPerKChar: clamp(ewma(before.secondsPerKChar, rate, before.samples), ...band),
      slowdown: ewma(before.slowdown, slowdown, before.samples),
      samples: before.samples + 1,
    });
  }
}
