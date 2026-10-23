import { formatMinutes } from "@/ui/shared/lib/format";

/** Progress is not trusted until it has moved this far and this long has passed. */
const MIN_PROGRESS = 0.05;
const MIN_ELAPSED_MS = 8000;

export interface ProgressSample {
  at: number;
  progress: number;
}

/**
 * Seconds left at the speed so far, from the first reading of a build to the latest, or null
 * when there is too little to go on (the first seconds, the first few percent, no movement).
 */
export function secondsLeft(first: ProgressSample, latest: ProgressSample): number | null {
  const moved = latest.progress - first.progress;
  const elapsed = latest.at - first.at;
  if (moved < MIN_PROGRESS || elapsed < MIN_ELAPSED_MS || latest.progress >= 1) return null;
  return ((1 - latest.progress) / moved) * (elapsed / 1000);
}

/** `less than a minute left`, `about 3 min left`, `about 1 h 20 min left`. */
export function formatLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  return `about ${formatMinutes(Math.round(seconds / 60))} left`;
}
