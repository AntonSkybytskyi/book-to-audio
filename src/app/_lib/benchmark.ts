import type { BenchmarkInfo, BenchmarkResult } from "./api";
import type { BenchmarkEvent } from "./events";
import { formatApprox, languageName, pluralize } from "./format";

/**
 * Applies a speed test event to what the settings page shows. Returns null when a run has just
 * finished and the new results have to be loaded.
 */
export function patchBenchmark(info: BenchmarkInfo, event: BenchmarkEvent): BenchmarkInfo | null {
  if (event.state === "idle" && event.outcome === "completed") return null;
  const { type: _type, ...status } = event;
  return { ...info, ...status };
}

/** The speed test is waiting or running: it can be cancelled, and a second run is refused. */
export const benchmarkBusy = (info: Pick<BenchmarkInfo, "state">): boolean => info.state !== "idle";

/** Seconds until the speed test is over, as far as can be told, or null when none is waiting or running. */
export function speedTestSecondsLeft(
  info: Pick<BenchmarkInfo, "state" | "progress" | "expectedSeconds"> | null,
): number | null {
  if (!info) return null;
  if (info.state === "waiting") return info.expectedSeconds;
  if (info.state === "running") return info.expectedSeconds * (1 - info.progress);
  return null;
}

/** `0.04` becomes `25× real time`: how many seconds of audio come out per second of waiting. */
export const realTimeSpeed = (rtf: number): string =>
  rtf > 0 ? `${rtf >= 0.2 ? (1 / rtf).toFixed(1) : Math.round(1 / rtf)}× real time` : "instant";

/** `0.0412` becomes `0.041`. */
export const formatRtf = (rtf: number): string => (rtf < 0.1 ? rtf.toFixed(3) : rtf.toFixed(2));

/** Seconds of audio per 1,000 characters, as `57 s`. */
export const formatRate = (secondsPerKChar: number): string => `${Math.round(secondsPerKChar)} s`;

/** The yardstick novel's conversion time, as `about 25 min`; `under a minute` needs no `about`. */
export const formatNovel = (result: BenchmarkResult): string => {
  const text = formatApprox(result.novelConvertSeconds);
  return text === "under a minute" ? text : `about ${text}`;
};

/** One line saying what the speed test is doing or how the last run ended; empty when there is nothing to say. */
export function benchmarkStatusLine(info: BenchmarkInfo): string {
  switch (info.state) {
    case "waiting":
      return info.trigger === "startup"
        ? "Waiting for a quiet moment: the first speed test starts when no chapter is being read."
        : "Waiting for the chapters being read to finish. No new chapter starts until the test is done.";
    case "running": {
      const percent = Math.round(info.progress * 100);
      const what = info.language ? `${languageName(info.language)} voice` : "voices";
      return `Measuring the ${what}… ${percent}%`;
    }
    case "cancelling":
      return "Stopping the speed test…";
    case "idle":
      if (info.outcome === "failed") return info.error ?? "The speed test could not be finished.";
      if (info.outcome === "cancelled") {
        return "The speed test was cancelled. The earlier results are unchanged.";
      }
      return "";
  }
}

/**
 * How busy the computer was around a run: the load when it began and when it ended (which includes the
 * run itself), and, when it began busy, that the speed is probably understated.
 */
export function loadNote(
  result: Pick<BenchmarkResult, "loadStart" | "loadEnd" | "busy">,
  cpuCount: number,
): string | null {
  if (result.loadStart === null) return null;
  const end = result.loadEnd === null ? "" : ` and ${result.loadEnd.toFixed(1)} when it ended`;
  const seen = `The computer's load was ${result.loadStart.toFixed(1)} when the test began${end} (the end includes the test itself).`;
  return result.busy
    ? `${seen} It was busier than its ${cpuCount} cores then, so the speed is probably understated; the test repeats itself once at the next start.`
    : seen;
}

/** The hint about the worker count, or null when there are no results to base it on. */
export function workersHint(info: BenchmarkInfo): string | null {
  if (info.suggestedWorkers === null) return null;
  const now = pluralize(info.workers, "worker");
  if (info.suggestedWorkers === info.workers) {
    return `The test agrees with your setting of ${now}: more would hardly be faster.`;
  }
  return `The test suggests ${pluralize(info.suggestedWorkers, "worker")}, which is about as fast as it gets on this computer. You have ${now}. This is only a hint.`;
}
