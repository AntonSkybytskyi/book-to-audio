import { describe, expect, it } from "vitest";
import type { BenchmarkInfo, BenchmarkResult } from "./api";
import {
  benchmarkBusy,
  benchmarkStatusLine,
  formatNovel,
  formatRate,
  formatRtf,
  loadNote,
  patchBenchmark,
  realTimeSpeed,
  speedTestSecondsLeft,
  workersHint,
} from "./benchmark";
import type { BenchmarkEvent } from "./events";

const info = (overrides: Partial<BenchmarkInfo> = {}): BenchmarkInfo => ({
  state: "idle",
  trigger: null,
  progress: 0,
  language: null,
  startedAt: null,
  outcome: null,
  error: null,
  expectedSeconds: 180,
  rows: [],
  workers: 2,
  maxWorkers: 12,
  suggestedWorkers: null,
  machine: { cpuCount: 12, cpuModel: "Test" },
  needsRun: false,
  ...overrides,
});

const event = (overrides: Partial<BenchmarkEvent> = {}): BenchmarkEvent => ({
  type: "benchmark",
  state: "idle",
  trigger: null,
  progress: 0,
  language: null,
  startedAt: null,
  outcome: null,
  error: null,
  expectedSeconds: 180,
  ...overrides,
});

describe("patchBenchmark", () => {
  it("follows the state and progress of a run, and keeps the results", () => {
    const before = info({ rows: [{ language: "en", voiceId: "v", result: null }] });

    const after = patchBenchmark(
      before,
      event({ state: "running", trigger: "manual", progress: 0.4, language: "uk" }),
    );

    expect(after).toMatchObject({
      state: "running",
      progress: 0.4,
      language: "uk",
      trigger: "manual",
    });
    expect(after?.rows).toBe(before.rows);
    expect(after).not.toHaveProperty("type");
  });

  it("asks for the results when a run has just finished", () => {
    expect(patchBenchmark(info(), event({ outcome: "completed" }))).toBeNull();
  });

  it("shows a run that was cancelled or failed without loading anything", () => {
    const after = patchBenchmark(
      info({ state: "running" }),
      event({ outcome: "failed", error: "Piper is not installed." }),
    );

    expect(after).toMatchObject({
      state: "idle",
      outcome: "failed",
      error: "Piper is not installed.",
    });
  });
});

describe("benchmarkBusy", () => {
  it("is true while waiting, running or stopping", () => {
    expect(benchmarkBusy({ state: "idle" })).toBe(false);
    for (const state of ["waiting", "running", "cancelling"] as const) {
      expect(benchmarkBusy({ state })).toBe(true);
    }
  });
});

describe("number formats", () => {
  it("says how much faster than real time a voice reads", () => {
    expect(realTimeSpeed(0.04)).toBe("25× real time");
    expect(realTimeSpeed(0.5)).toBe("2.0× real time");
    expect(realTimeSpeed(0)).toBe("instant");
  });

  it("keeps three digits of a small factor", () => {
    expect(formatRtf(0.0412)).toBe("0.041");
    expect(formatRtf(0.25)).toBe("0.25");
  });

  it("rounds the speech rate to whole seconds", () => {
    expect(formatRate(57.4)).toBe("57 s");
  });

  it("says the novel's time like the rest of the app", () => {
    expect(formatNovel({ novelConvertSeconds: 1500 } as BenchmarkResult)).toBe("about 25 min");
    expect(formatNovel({ novelConvertSeconds: 20 } as BenchmarkResult)).toBe("under a minute");
  });
});

describe("benchmarkStatusLine", () => {
  it("says nothing when nothing is going on", () => {
    expect(benchmarkStatusLine(info())).toBe("");
  });

  it("explains each wait", () => {
    expect(benchmarkStatusLine(info({ state: "waiting", trigger: "startup" }))).toMatch(
      /quiet moment/,
    );
    expect(benchmarkStatusLine(info({ state: "waiting", trigger: "manual" }))).toMatch(
      /No new chapter starts/,
    );
  });

  it("names the voice and the progress while measuring", () => {
    expect(benchmarkStatusLine(info({ state: "running", language: "uk", progress: 0.456 }))).toBe(
      "Measuring the Ukrainian voice… 46%",
    );
    expect(benchmarkStatusLine(info({ state: "running", progress: 0 }))).toBe(
      "Measuring the voices… 0%",
    );
  });

  it("says it is stopping", () => {
    expect(benchmarkStatusLine(info({ state: "cancelling" }))).toMatch(/Stopping/);
  });

  it("reports how the last run ended", () => {
    expect(benchmarkStatusLine(info({ outcome: "failed", error: "No voice is installed." }))).toBe(
      "No voice is installed.",
    );
    expect(benchmarkStatusLine(info({ outcome: "failed" }))).toMatch(/could not be finished/);
    expect(benchmarkStatusLine(info({ outcome: "cancelled" }))).toMatch(
      /earlier results are unchanged/,
    );
    expect(benchmarkStatusLine(info({ outcome: "completed" }))).toBe("");
  });
});

describe("workersHint", () => {
  it("has no hint without results", () => {
    expect(workersHint(info())).toBeNull();
  });

  it("agrees when the setting is already the best", () => {
    expect(workersHint(info({ suggestedWorkers: 2, workers: 2 }))).toMatch(
      /agrees with your setting of 2 workers/,
    );
  });

  it("suggests another count, as a hint only", () => {
    const hint = workersHint(info({ suggestedWorkers: 3, workers: 6 }));

    expect(hint).toMatch(/suggests 3 workers/);
    expect(hint).toMatch(/You have 6 workers/);
    expect(hint).toMatch(/only a hint/);
  });

  it("says one worker, not 1 workers", () => {
    expect(workersHint(info({ suggestedWorkers: 1, workers: 4 }))).toMatch(/suggests 1 worker,/);
  });
});

describe("speedTestSecondsLeft", () => {
  it("is the whole run while waiting, what is left while running, and nothing otherwise", () => {
    expect(speedTestSecondsLeft(info({ state: "waiting", expectedSeconds: 160 }))).toBe(160);
    expect(
      speedTestSecondsLeft(info({ state: "running", expectedSeconds: 160, progress: 0.75 })),
    ).toBe(40);
    expect(speedTestSecondsLeft(info({ state: "cancelling" }))).toBeNull();
    expect(speedTestSecondsLeft(info())).toBeNull();
    expect(speedTestSecondsLeft(null)).toBeNull();
  });
});

describe("loadNote", () => {
  it("says how busy the computer was when the run began and ended", () => {
    expect(loadNote({ loadStart: 3.14, loadEnd: 9.46, busy: false }, 12)).toBe(
      "The computer's load was 3.1 when the test began and 9.5 when it ended (the end includes the test itself).",
    );
  });

  it("says the speed is probably understated, and that it repeats once, when it began busy", () => {
    const note = loadNote({ loadStart: 20, loadEnd: 25, busy: true }, 12);

    expect(note).toMatch(/busier than its 12 cores/);
    expect(note).toMatch(/probably understated/);
    expect(note).toMatch(/repeats itself once/);
  });

  it("says nothing for a result from before the load was kept", () => {
    expect(loadNote({ loadStart: null, loadEnd: null, busy: false }, 12)).toBeNull();
  });
});
