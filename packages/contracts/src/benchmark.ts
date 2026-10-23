import type { ThroughputPoint } from "./estimate.js";

/**
 * `waiting`: the pool is being held for the benchmark and chapters are finishing. `running`:
 * voices are being measured. `cancelling`: the benchmark was told to stop and is closing its
 * engine processes.
 */
export type BenchmarkState = "idle" | "waiting" | "running" | "cancelling";

/** `startup`: the first-start run, which only begins while the pool is idle. `manual`: asked for. */
export type BenchmarkTrigger = "startup" | "manual";

/** How the last benchmark since the app started ended. */
export type BenchmarkOutcome = "completed" | "cancelled" | "failed";

/** The state of the speed test, also sent as the `benchmark` event. */
export interface BenchmarkStatus {
  state: BenchmarkState;
  trigger: BenchmarkTrigger | null;
  /** 0 to 1 while running. */
  progress: number;
  /** The language being measured. */
  language: string | null;
  startedAt: string | null;
  /** Set once a run has ended, until the next one starts. */
  outcome: BenchmarkOutcome | null;
  /** Why the last run failed, in words for the page. */
  error: string | null;
  /** How long a run is expected to take, from the last one (or a guess before any). */
  expectedSeconds: number;
}

/** One voice's result. */
export interface ResultView {
  secondsPerKChar: number;
  rtf: number;
  encodeFactor: number | null;
  modelLoadSeconds: number;
  throughput: ThroughputPoint[];
  sampleChars: number;
  sampleAudioSeconds: number;
  measuredAt: string;
  /** Audio of the yardstick novel in this voice, and the time to convert it with the current workers. */
  novelAudioSeconds: number;
  novelConvertSeconds: number;
  /** Measured on another machine or with older text rules than the ones in use. */
  outdated: boolean;
  /** The load average when the run began and ended; the second includes the run itself. */
  loadStart: number | null;
  loadEnd: number | null;
  /** The computer was busier than it has cores when the run began, so the speed is probably understated. */
  busy: boolean;
}

export interface BenchmarkRowView {
  language: string;
  voiceId: string;
  result: ResultView | null;
}

export interface MachineInfo {
  cpuCount: number;
  cpuModel: string;
}

/** `GET`, `POST` and `DELETE /api/benchmark`. */
export interface BenchmarkView extends BenchmarkStatus {
  rows: BenchmarkRowView[];
  workers: number;
  maxWorkers: number;
  /** The fewest workers that get close to the best throughput measured; a hint only. */
  suggestedWorkers: number | null;
  machine: MachineInfo;
  /** A voice has no result, or one that is outdated: a run is due. */
  needsRun: boolean;
}
