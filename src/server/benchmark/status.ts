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

/** About what a run took in the container, until one has been timed here. */
export const DEFAULT_EXPECTED_SECONDS = 180;

export const IDLE_STATUS: BenchmarkStatus = {
  state: "idle",
  trigger: null,
  progress: 0,
  language: null,
  startedAt: null,
  outcome: null,
  error: null,
  expectedSeconds: DEFAULT_EXPECTED_SECONDS,
};
