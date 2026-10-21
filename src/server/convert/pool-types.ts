import type { ChapterQueue } from "../books/queue.js";
import type { EventBus } from "../events/bus.js";
import type { SettingsStore } from "../settings/settings.js";
import type { TtsEngine } from "../tts/engine.js";
import type { ChapterConverter } from "./convert-chapter.js";
import type { PauseCause, PoolStateName, PoolStateStore } from "./pool-state.js";

export interface PoolLogger {
  info(message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface PoolStatus {
  state: PoolStateName;
  /** Why the pool paused. */
  error: string | null;
  cause: PauseCause | null;
  /** Workers wanted by the settings. */
  workers: number;
  /** Workers converting a chapter right now. */
  activeWorkers: number;
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
}
