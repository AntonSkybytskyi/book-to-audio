import { audioSecondsFor, conversionSeconds } from "../../shared/estimate.js";
import { benchmarkModel } from "../speed/calibration.js";
import type { MachineInfo, StoredBenchmark, VoiceMeasurement } from "./repository.js";

/** Same yardstick as the Settings page: 90,000 words in 30 chapters. */
const NOVEL_WORDS = 90_000;
const NOVEL_CHAPTERS = 30;
const CHARS_PER_WORD: Readonly<Record<string, number>> = { en: 5.8, uk: 7.3, ru: 7.1 };

export const novelChars = (language: string): number =>
  NOVEL_WORDS * (CHARS_PER_WORD[language] ?? 6.5);

/** Hours the yardstick novel takes with `workers` workers, from a measurement. */
export function novelHours(m: VoiceMeasurement, workers: number): number {
  const model = benchmarkModel(m as StoredBenchmark);
  const audio = audioSecondsFor(model, novelChars(m.language));
  const chapters = Array.from({ length: NOVEL_CHAPTERS }, () => audio / NOVEL_CHAPTERS);
  return conversionSeconds(model, chapters, workers) / 3600;
}

/** Left-aligned first column, right-aligned numbers, two spaces between columns. */
function grid(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((row) => (row[col] ?? "").length)),
  );
  return rows
    .map((row, r) =>
      row
        .map((cell, col) =>
          col === 0 || (r === 0 && col < 2)
            ? cell.padEnd(widths[col] ?? 0)
            : cell.padStart(widths[col] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const fixed = (value: number, digits = 1) => value.toFixed(digits);

/** The tables `pnpm benchmark` prints. */
export function formatBenchmark(
  measurements: readonly VoiceMeasurement[],
  context: {
    machine: MachineInfo;
    /** The 1-minute load average when it started and when it ended (which includes the test itself). */
    loadAverage: number;
    loadEnd?: number;
    workerCounts: readonly number[];
  },
): string {
  const { machine, loadAverage, loadEnd, workerCounts } = context;
  const speech = grid([
    [
      "Voice",
      "Language",
      "Audio per 1,000 chars",
      "Real-time factor",
      "Opus encode",
      "Model load",
      "Sample",
    ],
    ...measurements.map((m) => [
      m.voiceId,
      m.language,
      `${fixed(m.secondsPerKChar)} s`,
      fixed(m.rtf, 3),
      m.encodeFactor === null ? "n/a" : fixed(m.encodeFactor, 3),
      `${fixed(m.modelLoadMs / 1000)} s`,
      `${m.sampleChars} chars, ${fixed(m.sampleAudioSeconds, 0)} s`,
    ]),
  ]);
  const counts = [
    ...new Set(measurements.flatMap((m) => m.throughput.map((p) => p.workers))),
  ].toSorted((a, b) => a - b);
  const speed = grid([
    ["Throughput (audio s per s)", "", ...counts.map((n) => `${n} at once`)],
    ...measurements.map((m) => [
      m.voiceId,
      m.language,
      ...counts.map((n) => {
        const point = m.throughput.find((p) => p.workers === n);
        return point ? fixed(point.audioPerSecond) : "-";
      }),
    ]),
  ]);
  const novel = grid([
    [
      "90,000-word novel (hours)",
      "",
      ...workerCounts.map((n) => (n === 1 ? "1 worker" : `${n} workers`)),
    ],
    ...measurements.map((m) => [
      m.voiceId,
      m.language,
      ...workerCounts.map((n) => {
        const hours = novelHours(m, n);
        return `${fixed(hours, 2)} h (${Math.round(hours * 60)} min)`;
      }),
    ]),
  ]);
  return [
    `Machine: ${machine.cpuModel}, ${machine.cpuCount} cores. Load average when it started: ${fixed(loadAverage, 2)}${
      loadEnd === undefined
        ? ""
        : `, when it ended: ${fixed(loadEnd, 2)} (that includes the test itself)`
    }.`,
    "Other programs using the processor make every number here worse than it would be on a quiet machine.",
    "",
    speech,
    "",
    speed,
    "",
    novel,
  ].join("\n");
}
