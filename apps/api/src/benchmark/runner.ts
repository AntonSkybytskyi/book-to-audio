import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LANGUAGES } from "../books/languages.js";
import type { PoolControl } from "../convert/pool-types.js";
import { UserFacingError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import type { CatalogVoice, TtsCatalog } from "../tts/catalog.js";
import { TtsError } from "../tts/engine.js";
import { measureVoice, type MeasureDeps } from "./measure.js";
import {
  wasBusy,
  type BenchmarkRepository,
  type MachineInfo,
  type RunInfo,
  type VoiceMeasurement,
} from "./repository.js";
import {
  DEFAULT_EXPECTED_SECONDS,
  IDLE_STATUS,
  type BenchmarkStatus,
  type BenchmarkTrigger,
} from "./status.js";

/** Most sessions the benchmark compares; beyond this, more would only repeat what the pool measures itself. */
const MAX_COMPARED_WORKERS = 4;
/** The configured worker count is measured too, when it is higher than this, up to a limit. */
const MAX_EXTRA_WORKERS = 8;

export class BenchmarkBusyError extends Error {
  constructor() {
    super("A speed test is already running.");
    this.name = "BenchmarkBusyError";
  }
}

/** Refused because the app is shutting down. */
export class BenchmarkStoppedError extends Error {
  constructor() {
    super("The app is shutting down.");
    this.name = "BenchmarkStoppedError";
  }
}

export interface BenchmarkLogger {
  info(message: string): void;
  warn(context: object, message: string): void;
}

export interface BenchmarkDeps extends Pick<MeasureDeps, "prepare" | "encode" | "now"> {
  catalog: TtsCatalog;
  repo: BenchmarkRepository;
  pool: Pick<PoolControl, "hold" | "holdWhenIdle">;
  bus: EventBus;
  /** A TTS service's worker count in use, and the most sessions worth comparing on it. */
  workers: (service: string) => { current: number; max: number };
  /** Parent of the folder for the encoded chunks. */
  scratchDir: string;
  machine: () => MachineInfo;
  /** The wall clock, for the time a result was measured. */
  clock?: () => Date;
  /** The 1-minute load average; tests pass their own. */
  loadAverage?: () => number;
  logger?: BenchmarkLogger;
}

/** The voice of each language: the ones the app reads books with. */
export function benchmarkVoices(catalog: TtsCatalog): CatalogVoice[] {
  return LANGUAGES.flatMap((language) => catalog.voiceFor(language) ?? []);
}

/**
 * Session counts to compare: one up to four (or the most the settings allow), and the worker count
 * in use when it is higher, so the estimate for it is measured and not extrapolated.
 */
export function workerCountsFor(current: number, max: number): number[] {
  const counts = Array.from({ length: Math.min(max, MAX_COMPARED_WORKERS) }, (_, i) => i + 1);
  if (current > MAX_COMPARED_WORKERS) counts.push(Math.min(current, max, MAX_EXTRA_WORKERS));
  return [...new Set(counts)];
}

/**
 * Runs the speed benchmark, one at a time, with the pool held so that no conversion competes with
 * it. Results are saved together when every voice is done; a cancelled run changes nothing.
 */
export class BenchmarkRunner {
  private current: BenchmarkStatus;
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** Ends the wait for the pool, so a start by hand can replace the first-start wait. */
  private waitAbort: AbortController | null = null;
  private closed = false;
  private startedMs = 0;
  /** The load when the run was asked for, before it waited for the pool: what the app itself did while it waited is not in it. */
  private loadAtStart = 0;

  constructor(private readonly deps: BenchmarkDeps) {
    this.current = { ...IDLE_STATUS, expectedSeconds: this.expectedSeconds() };
  }

  status(): BenchmarkStatus {
    return this.current;
  }

  get busy(): boolean {
    return this.current.state !== "idle";
  }

  /** Seconds until the run is over, as far as can be told, or null when none is under way. */
  expectedRemainingSeconds(): number | null {
    const { state, progress, expectedSeconds } = this.current;
    if (state === "waiting") return expectedSeconds;
    if (state === "running") return expectedSeconds * (1 - progress);
    return null;
  }

  /**
   * Whether a voice has no result, or its result is from another machine or other text rules, or
   * was measured while the computer was busy (and has not been repeated since).
   */
  needsRun(): boolean {
    const { catalog, repo, machine } = this.deps;
    const here = machine();
    return benchmarkVoices(catalog).some((voice) => {
      const row = repo.get(voice.engine, voice.id);
      return (
        !row ||
        row.cpuCount !== here.cpuCount ||
        row.cpuModel !== here.cpuModel ||
        row.textVersion !== TEXT_PROCESSING_VERSION ||
        (wasBusy(row) && row.loadAttempt < 2)
      );
    });
  }

  /** The first-start run: only if something needs measuring, and it waits for the pool to be idle. */
  startIfNeeded(): boolean {
    if (this.closed || this.busy || !this.needsRun()) return false;
    this.start("startup");
    return true;
  }

  /**
   * Starts a run in the background. Throws `BenchmarkBusyError` while another is going on, except that
   * a start by hand takes over a first-start run that is still waiting for a quiet moment, and
   * `BenchmarkStoppedError` once the app is shutting down.
   */
  start(trigger: BenchmarkTrigger): BenchmarkStatus {
    if (this.closed) throw new BenchmarkStoppedError();
    if (this.busy) {
      if (
        trigger === "manual" &&
        this.current.state === "waiting" &&
        this.current.trigger === "startup"
      ) {
        this.set({ ...this.current, trigger: "manual" });
        this.waitAbort?.abort(); // the run asks again, now for the pool at once
        return this.current;
      }
      throw new BenchmarkBusyError();
    }
    this.abort = new AbortController();
    this.loadAtStart = this.loadAverage();
    this.set({
      ...IDLE_STATUS,
      expectedSeconds: this.expectedSeconds(),
      state: "waiting",
      trigger,
      startedAt: (this.deps.clock?.() ?? new Date()).toISOString(),
    });
    this.job = this.run(this.abort.signal);
    return this.current;
  }

  /** Stops the run, if there is one, and resolves once its engine processes are gone. */
  async cancel(): Promise<void> {
    if (!this.job) return;
    this.abort?.abort();
    if (this.current.state !== "cancelling") this.set({ ...this.current, state: "cancelling" });
    await this.job;
  }

  /** Cancels, and refuses to start anything again: for the app's shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.cancel();
  }

  /** The longest run so far, or a guess. */
  private expectedSeconds(): number {
    const seconds = this.deps.repo.all().flatMap((row) => (row.seconds ? [row.seconds] : []));
    return seconds.length > 0 ? Math.max(...seconds) : DEFAULT_EXPECTED_SECONDS;
  }

  private set(next: BenchmarkStatus): void {
    this.current = next;
    this.deps.bus.publish({ type: "benchmark", ...next });
  }

  private loadAverage(): number {
    return (this.deps.loadAverage ?? (() => os.loadavg()[0] ?? 0))();
  }

  /** Waits for the pool: at once for a run by hand, at a quiet moment for the first-start one. */
  private async acquirePool(signal: AbortSignal): Promise<() => void> {
    const { pool } = this.deps;
    for (;;) {
      const waiting = new AbortController();
      this.waitAbort = waiting;
      const both = AbortSignal.any([signal, waiting.signal]);
      try {
        return await (this.current.trigger === "manual"
          ? pool.hold(both)
          : pool.holdWhenIdle(both));
      } catch (error) {
        // Only the wait was ended (a start by hand took over): ask again.
        if (signal.aborted || !waiting.signal.aborted) throw error;
      } finally {
        this.waitAbort = null;
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { logger } = this.deps;
    let release: (() => void) | null = null;
    let scratch: string | null = null;
    let outcome: BenchmarkStatus["outcome"] = "completed";
    let error: string | null = null;
    try {
      release = await this.acquirePool(signal);
      if (signal.aborted) throw new TtsError("aborted", "The speed test was cancelled.");
      this.set({ ...this.current, state: "running" });
      const loadStart = this.loadAtStart;
      this.startedMs = this.deps.now();
      await fs.mkdir(this.deps.scratchDir, { recursive: true, mode: 0o700 });
      scratch = await fs.mkdtemp(path.join(this.deps.scratchDir, "benchmark-"));
      await this.measureAll(scratch, signal, loadStart);
      logger?.info("the speed test finished");
    } catch (caught) {
      if (signal.aborted) {
        outcome = "cancelled";
      } else {
        outcome = "failed";
        error =
          caught instanceof UserFacingError
            ? caught.message
            : "The speed test could not be finished.";
        logger?.warn({ err: caught }, "the speed test failed");
      }
    } finally {
      release?.();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      this.abort = null;
      this.job = null;
      this.set({ ...IDLE_STATUS, expectedSeconds: this.expectedSeconds(), outcome, error });
    }
  }

  private async measureAll(
    scratchDir: string,
    signal: AbortSignal,
    loadStart: number,
  ): Promise<void> {
    const { catalog, repo, logger } = this.deps;
    const voices = benchmarkVoices(catalog);
    if (voices.length === 0) {
      throw new TtsError(
        "voice_not_found",
        "No voice is installed, so there is nothing to measure.",
      );
    }
    const measurements: VoiceMeasurement[] = [];
    let firstFailure: unknown = null;
    for (const [index, voice] of voices.entries()) {
      this.set({ ...this.current, language: voice.language, progress: index / voices.length });
      try {
        const engine = catalog.engine(voice.engine);
        if (!engine) throw new TtsError("voice_not_found", "The voice's speech service is gone.");
        const { current, max } = this.deps.workers(voice.engine);
        measurements.push(
          await measureVoice({ ...this.deps, engine, scratchDir }, voice, {
            workerCounts: workerCountsFor(current, max),
            signal,
            onProgress: (share) =>
              this.set({ ...this.current, progress: (index + share) / voices.length }),
          }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // One voice that cannot be read must not cost the others their results.
        logger?.warn({ err: error, voice: voice.id }, "a voice could not be measured");
        firstFailure ??= error;
      }
    }
    if (measurements.length === 0) throw firstFailure;
    const run: RunInfo = {
      loadStart,
      loadEnd: this.loadAverage(),
      seconds: (this.deps.now() - this.startedMs) / 1000,
    };
    repo.save(
      measurements,
      this.deps.machine(),
      TEXT_PROCESSING_VERSION,
      (this.deps.clock?.() ?? new Date()).toISOString(),
      run,
    );
  }
}
