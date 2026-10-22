// Time estimates, shared by the server and the pages so both give the same numbers.
// Pure functions only, and no imports: Next (bundler) and the server (NodeNext) both compile this file.

/** `rough`: built-in defaults. `benchmark`: measured on this computer. `learned`: refined by real conversions. */
export type SpeedSource = "rough" | "benchmark" | "learned";

/** Audio produced per second of waiting, all sessions together, with `workers` sessions at once. */
export interface ThroughputPoint {
  workers: number;
  audioPerSecond: number;
}

export interface SpeedModel {
  /** Seconds of audio per 1,000 characters of prepared text. */
  secondsPerKChar: number;
  /** From one session up; more sessions compete for cores, so it grows slower than the count. */
  throughput: ThroughputPoint[];
  /** Waiting time a chapter costs besides reading it: text preparation, joining the chunks. */
  chapterOverheadSeconds: number;
  /** How much slower real conversions were than the model said (1 = as measured). */
  slowdown: number;
  source: SpeedSource;
}

/** What is left of a chapter's audio, in seconds, for chapters that are not finished. */
export type RemainingAudio = readonly number[];

/** The part of a chapter the estimates look at. */
export interface ChapterWork {
  status: string;
  /** 0 to 1, of the chunks done. */
  progress: number;
  preparedChars: number;
}

const MIN_EFFICIENCY = 0.05;
/** Weight of a new sample once there are many. */
const EWMA_ALPHA = 0.25;
/** A single odd chapter must not move the estimate by more than this factor. */
export const SLOWDOWN_LIMITS = { min: 0.2, max: 5 } as const;

/** Audio per second at a number of sessions: straight lines between measured points, flat past the last. */
export function throughputAt(points: readonly ThroughputPoint[], workers: number): number {
  const sorted = points.toSorted((a, b) => a.workers - b.workers);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new RangeError("a speed model needs at least one throughput point");
  if (workers <= first.workers) return first.audioPerSecond * (workers / first.workers);
  if (workers >= last.workers) return last.audioPerSecond;
  for (let i = 1; i < sorted.length; i++) {
    const to = sorted[i];
    const from = sorted[i - 1];
    if (to && from && workers <= to.workers) {
      const share = (workers - from.workers) / (to.workers - from.workers);
      return from.audioPerSecond + share * (to.audioPerSecond - from.audioPerSecond);
    }
  }
  return last.audioPerSecond;
}

/** Speed of each of `active` busy workers compared with one worker alone: 1 means no slowing down. */
export function efficiency(model: SpeedModel, active: number): number {
  if (active <= 1) return 1;
  const alone = throughputAt(model.throughput, 1);
  return Math.max(MIN_EFFICIENCY, throughputAt(model.throughput, active) / (active * alone));
}

export const audioSecondsFor = (model: SpeedModel, preparedChars: number): number =>
  (Math.max(0, preparedChars) / 1000) * model.secondsPerKChar;

/**
 * Audio left in the chapters that still have to be read: running ones first (in the order the
 * workers took them), then the waiting ones in reading order. Done and failed chapters are left out.
 */
export function remainingAudio(model: SpeedModel, chapters: readonly ChapterWork[]): number[] {
  const running = chapters.filter((c) => c.status === "generating");
  const waiting = chapters.filter((c) => c.status === "queued" || c.status === "pending");
  return [
    ...running.map((c) => audioSecondsFor(model, c.preparedChars) * (1 - clamp(c.progress, 0, 1))),
    ...waiting.map((c) => audioSecondsFor(model, c.preparedChars)),
  ];
}

/** Seconds one worker alone needs for a chapter with this much audio left, joining included. */
export function chapterWorkSeconds(model: SpeedModel, audioSeconds: number): number {
  return audioSeconds / throughputAt(model.throughput, 1) + model.chapterOverheadSeconds;
}

/** Seconds a chapter takes while `concurrency` workers are busy, before the learned slowdown. */
export const chapterWallSeconds = (
  model: SpeedModel,
  audioSeconds: number,
  concurrency: number,
): number => chapterWorkSeconds(model, audioSeconds) / efficiency(model, Math.max(1, concurrency));

/**
 * Seconds until every chapter is read, with `workers` workers taking chapters in the order given
 * (running ones first). Workers slow each other down as more are busy, and the last chapters run
 * with fewer workers, so this steps through the schedule instead of dividing the total.
 */
export function conversionSeconds(
  model: SpeedModel,
  remaining: RemainingAudio,
  workers: number,
): number {
  const jobs = remaining.filter((audio) => audio > 0).map((a) => chapterWorkSeconds(model, a));
  const slots = Math.max(1, Math.floor(workers));
  const active: number[] = [];
  let next = 0;
  let time = 0;
  const fill = () => {
    while (active.length < slots && next < jobs.length) active.push(jobs[next++] ?? 0);
  };
  fill();
  while (active.length > 0) {
    const rate = efficiency(model, active.length);
    const step = Math.min(...active) / rate;
    time += step;
    const done = step * rate;
    for (let i = active.length - 1; i >= 0; i--) {
      const left = (active[i] ?? 0) - done;
      if (left <= 1e-9) active.splice(i, 1);
      else active[i] = left;
    }
    fill();
  }
  return time * model.slowdown;
}

/** A running average that starts as a plain average and settles into a steady weight. */
export function ewma(previous: number, sample: number, samples: number): number {
  const weight = Math.max(EWMA_ALPHA, 1 / (samples + 2));
  return previous + (sample - previous) * weight;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** The fewest workers that get within 5% of the best throughput measured; a hint, not a rule. */
export function suggestedWorkers(points: readonly ThroughputPoint[]): number {
  const best = Math.max(...points.map((p) => p.audioPerSecond));
  const close = points
    .filter((p) => p.audioPerSecond >= best * 0.95)
    .toSorted((a, b) => a.workers - b.workers)[0];
  return close?.workers ?? 1;
}
