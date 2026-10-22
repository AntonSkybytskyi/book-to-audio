import { describe, expect, it } from "vitest";
import { CHAPTER_OVERHEAD_SECONDS } from "../speed/calibration.js";
import { formatBenchmark, novelHours } from "./table.js";
import type { VoiceMeasurement } from "./repository.js";

const measurement = (overrides: Partial<VoiceMeasurement> = {}): VoiceMeasurement => ({
  engine: "piper",
  voiceId: "en_US-test",
  language: "en",
  secondsPerKChar: 57.4,
  rtf: 0.0412,
  encodeFactor: 0.0087,
  modelLoadMs: 233,
  throughput: [
    { workers: 1, audioPerSecond: 19.95 },
    { workers: 2, audioPerSecond: 23.6 },
  ],
  sampleChars: 1146,
  sampleAudioSeconds: 65,
  ...overrides,
});

const context = {
  machine: { cpuCount: 12, cpuModel: "Test CPU" },
  loadAverage: 4.5,
  workerCounts: [1, 2],
};

describe("novelHours", () => {
  it("is shorter with more workers where the throughput grows", () => {
    expect(novelHours(measurement(), 2)).toBeLessThan(novelHours(measurement(), 1));
  });

  it("is the audio of 90,000 words over the speed, with each chapter's overhead", () => {
    // 90,000 words of 5.8 characters at 57.4 s per 1,000: 29,960 s of audio at 19.95 audio s/s.
    const hours = novelHours(measurement(), 1);
    expect(hours).toBeCloseTo(
      ((90_000 * 5.8 * 57.4) / 1000 / 19.95 + 30 * CHAPTER_OVERHEAD_SECONDS) / 3600,
      6,
    );
  });
});

describe("formatBenchmark", () => {
  const table = formatBenchmark([measurement()], context);

  it("names the machine and the load it was measured under, and warns about other programs", () => {
    expect(table).toContain("Test CPU, 12 cores");
    expect(table).toContain("Load average when it started: 4.50");
    expect(table).toContain("Other programs using the processor");
  });

  it("says how busy it was at the end too, when it knows, noting that this includes the test", () => {
    const text = formatBenchmark([measurement()], { ...context, loadEnd: 11.25 });

    expect(text).toContain(
      "when it started: 4.50, when it ended: 11.25 (that includes the test itself)",
    );
  });

  it("shows the speech rate, the real-time factor, the encoding cost and the model load", () => {
    expect(table).toContain("en_US-test");
    expect(table).toContain("57.4 s");
    expect(table).toContain("0.041");
    expect(table).toContain("0.009");
    expect(table).toContain("0.2 s");
  });

  it("shows the throughput for each number of sessions", () => {
    expect(table).toContain("1 at once");
    expect(table).toContain("19.9");
    expect(table).toContain("2 at once");
    expect(table).toContain("23.6");
  });

  it("shows the hours for the yardstick novel for each worker count asked for", () => {
    expect(table).toContain("90,000-word novel (hours)");
    expect(table).toContain("1 worker");
    expect(table).toContain("2 workers");
    const hours = novelHours(measurement(), 2);
    expect(table).toContain(`${hours.toFixed(2)} h (${Math.round(hours * 60)} min)`);
  });

  it("says n/a for an encoding that was not measured, and a dash for a count not measured", () => {
    const text = formatBenchmark(
      [measurement({ encodeFactor: null, throughput: [{ workers: 1, audioPerSecond: 20 }] })],
      {
        ...context,
        workerCounts: [1],
      },
    );

    expect(text).toContain("n/a");
  });

  it("has one row per voice, lined up", () => {
    const text = formatBenchmark(
      [
        measurement(),
        measurement({
          voiceId: "uk_UA-test",
          language: "uk",
          throughput: [{ workers: 1, audioPerSecond: 21 }],
        }),
      ],
      context,
    );

    const lines = text.split("\n").filter((line) => line.includes("_"));
    expect(lines.length).toBeGreaterThanOrEqual(6); // three tables, two voices each
    const throughput = text
      .split("\n")
      .find((line) => line.startsWith("uk_UA-test") && line.includes("21.0"));
    expect(throughput).toContain("-"); // no 2-session result for that voice
  });
});
