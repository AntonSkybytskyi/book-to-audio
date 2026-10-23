import type { ChapterQueue } from "../books/queue.js";
import type { EventBus } from "../events/bus.js";
import type { SettingsStore } from "../settings/settings.js";
import type { TtsEngine } from "../tts/engine.js";
import type { ChapterConverter } from "./convert-chapter.js";
import type { Release } from "./pool-gate.js";
import type { PoolStatus } from "@book-to-audio/contracts";
import type { PoolStateStore } from "./pool-state.js";
export type { PoolStatus } from "@book-to-audio/contracts";

export interface PoolLogger {
  info(message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

/** One finished chapter, as the speed estimates learn from it. */
export interface ChapterTiming {
  voiceId: string;
  language: string;
  preparedChars: number;
  durationSeconds: number;
  /** Seconds the chapter took, from claim to saved. */
  wallSeconds: number;
  /** Average number of workers that were busy meanwhile, this one included. */
  concurrency: number;
}

export interface SpeedLearner {
  recordChapter(timing: ChapterTiming): void;
}

/** What the routes use. */
export interface PoolControl {
  /** Tells idle workers that new chapters were queued. */
  notify(): void;
  status(): PoolStatus;
  /** Lets a paused pool take work again. */
  resume(): PoolStatus;
  /** Takes effect at once: new workers start, extra ones stop after their current chapter. */
  setWorkers(count: number): PoolStatus;
  /**
   * Stops new chapters from starting and resolves once the running ones have finished, with the
   * function that gives the pool back. Cancelling `signal` while waiting gives it back too.
   */
  hold(signal?: AbortSignal): Promise<Release>;
  /** Waits for a moment with nothing running or waiting, holds the pool then, and resolves with the release. */
  holdWhenIdle(signal?: AbortSignal): Promise<Release>;
  /** Cancels a running chapter (by row id) and resolves once its worker has settled. */
  abortChapter(id: number, afterSettle?: () => void): Promise<void>;
  /** `abortChapter` for every running chapter of a book. */
  abortBook(bookId: string): Promise<void>;
}

export interface PoolDeps {
  queue: ChapterQueue;
  converter: ChapterConverter;
  engine: TtsEngine;
  state: PoolStateStore;
  settings: SettingsStore;
  bus: EventBus;
  logger?: PoolLogger;
  /** Pause after a worker hits a database error. Tests shorten it. */
  backoffMs?: number;
  /** How long an idle worker keeps its engine process. */
  sessionIdleMs?: number;
  /** Shortest time between progress events of one chapter. */
  progressIntervalMs?: number;
  /** Something else heavy is running (an M4B build): the pool does not count as idle then. */
  busyElsewhere?: () => boolean;
  /** Learns the speed of each voice from the chapters it finishes. */
  learner?: SpeedLearner;
  /** Milliseconds from a clock that never goes back; tests pass their own. */
  now?: () => number;
}
