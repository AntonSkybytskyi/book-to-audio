import type { BenchmarkStatus } from "@book-to-audio/contracts";

export type { BenchmarkTrigger, BenchmarkStatus } from "@book-to-audio/contracts";

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
