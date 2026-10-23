import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { BenchmarkRepository, type MachineInfo } from "../benchmark/repository.js";
import { BenchmarkRunner } from "../benchmark/runner.js";
import { prepareChunks } from "../convert/chapter-text.js";
import type { Release } from "../convert/pool-gate.js";
import type { AppEvent, BenchmarkEvent } from "../events/bus.js";
import type { TtsEngine } from "../tts/engine.js";
import { createTestContext, type TestContext } from "./context.js";
import { TimedEngine } from "./timed-engine.js";

export const VOICES = [
  { id: "t-en", language: "en", name: "En", sampleRate: 22_050 },
  { id: "t-uk", language: "uk", name: "Uk", sampleRate: 22_050 },
  { id: "t-ru", language: "ru", name: "Ru", sampleRate: 22_050 },
];

export const here: MachineInfo = { cpuCount: 8, cpuModel: "Test CPU" };

/** `vi.waitFor` with room for a busy machine. */
export const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 15_000 });

/** What the runner asked the pool for. */
export interface Gate {
  /** The signal of each request for the pool, and which kind it was. */
  asked: { signal: AbortSignal; kind: "hold" | "holdWhenIdle" }[];
  held: number;
  released: number;
  /** When set, the next request waits for this. */
  wait: Promise<void> | null;
}

export interface PoolStub {
  hold: (signal?: AbortSignal) => Promise<Release>;
  holdWhenIdle: (signal?: AbortSignal) => Promise<Release>;
}

export interface RunnerHarness {
  ctx: TestContext;
  engine: TimedEngine;
  repo: BenchmarkRepository;
  scratch: string;
  events: AppEvent[];
  gate: Gate;
  /** The machine the runner says it is on; change it to look like another one. */
  machine: MachineInfo;
  /** The 1-minute load average the runner reads. */
  load: number;
  runner: BenchmarkRunner;
  benchmarkEvents(): BenchmarkEvent[];
  build(overrides?: { engine?: TtsEngine; pool?: PoolStub }): BenchmarkRunner;
  /** Resolves when the runner is idle again. */
  finished(target?: BenchmarkRunner): Promise<void>;
  /** Makes every read wait, so a test can look at a run that is under way. */
  stallEngine(): void;
  unstallEngine(): void;
}

/** A runner over a timed engine, a database and a pool stub that records what it is asked for. */
export function useRunnerHarness(): RunnerHarness {
  let unstall: (() => void) | null = null;
  const h = {} as RunnerHarness;

  const holdFor =
    (kind: "hold" | "holdWhenIdle") =>
    async (signal?: AbortSignal): Promise<Release> => {
      h.gate.asked.push({ signal: signal as AbortSignal, kind });
      h.gate.held++;
      if (h.gate.wait) {
        const wait = h.gate.wait;
        await new Promise<void>((resolve, reject) => {
          void wait.then(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      }
      return () => {
        h.gate.released++;
      };
    };

  Object.assign(h, {
    benchmarkEvents: () =>
      h.events.filter((event): event is BenchmarkEvent => event.type === "benchmark"),
    build: (overrides: { engine?: TtsEngine; pool?: PoolStub } = {}) =>
      new BenchmarkRunner({
        engine: overrides.engine ?? h.engine,
        repo: h.repo,
        bus: h.ctx.bus,
        pool: overrides.pool ?? { hold: holdFor("hold"), holdWhenIdle: holdFor("holdWhenIdle") },
        workers: () => ({ current: 2, max: 3 }),
        scratchDir: h.scratch,
        machine: () => h.machine,
        prepare: prepareChunks,
        now: h.engine.now,
        clock: () => new Date("2026-03-04T05:06:07.000Z"),
        loadAverage: () => h.load,
      }),
    finished: async (target?: BenchmarkRunner) => {
      await waitFor(() => {
        if ((target ?? h.runner).status().state !== "idle") throw new Error("still running");
      });
    },
    stallEngine: () => {
      h.engine.stall = new Promise<void>((resolve) => (unstall = resolve));
    },
    unstallEngine: () => {
      h.engine.stall = null;
      unstall?.();
    },
  });

  beforeEach(() => {
    h.ctx = createTestContext();
    h.engine = new TimedEngine({ voices: VOICES });
    h.repo = new BenchmarkRepository(h.ctx.db);
    h.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    h.events = [];
    h.ctx.bus.subscribe((event) => h.events.push(event));
    h.gate = { asked: [], held: 0, released: 0, wait: null };
    h.machine = { ...here };
    h.load = 1;
    h.runner = h.build();
  });

  afterEach(async () => {
    h.unstallEngine();
    await h.runner.cancel();
    fs.rmSync(h.scratch, { recursive: true, force: true });
    h.ctx.cleanup();
  });

  return h;
}
