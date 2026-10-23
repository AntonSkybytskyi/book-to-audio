import {
  audioSecondsFor,
  conversionSeconds,
  remainingAudio,
  type SpeedModel,
  type SpeedSource,
} from "@book-to-audio/contracts";
import type { BookLoad } from "../books/repository.js";
import { pickVoice, type TtsEngine } from "../tts/engine.js";
import type { SpeedCalibration } from "./calibration.js";

/** Who is in front of a book in the queue, and how long until its turn. */
export interface QueueView {
  booksAhead: number;
  /** Null when nothing is ahead, or the pool is paused and no one can say. */
  startsInSeconds: number | null;
}

export interface BookEstimateView {
  /** The whole book read aloud. */
  audioSeconds: number;
  /** Converting it from the start with the workers in use. */
  convertSeconds: number;
  source: SpeedSource;
  workers: number;
  /** Where it would stand if it were queued now (for a book that is not queued yet). */
  queue: QueueView;
}

/**
 * `waiting`: other books go first. `waiting_for_speed_test`: the pool is held for the speed test, so
 * nothing starts until it is over. `paused`: this book is paused. `pool_paused`: all conversion is.
 */
export type TimeLeftState =
  | "running"
  | "waiting"
  | "waiting_for_speed_test"
  | "paused"
  | "pool_paused";

export interface TimeLeftView extends QueueView {
  state: TimeLeftState;
  /** Until this book is done, once it starts; null while paused. Failed chapters are not counted. */
  remainingSeconds: number | null;
  /** While `waiting_for_speed_test`: how long the speed test is expected to take yet. */
  speedTestSeconds: number | null;
  source: SpeedSource;
}

export interface BookEstimates {
  estimate: BookEstimateView;
  /** The prepared text of some chapter has not been counted yet, so the estimate stands on raw lengths. */
  measuring: boolean;
  /** Only for a book that is converting or paused. */
  timeLeft: TimeLeftView | null;
  /** What the pages need to keep the time left current as chapters progress. */
  speed: SpeedModel;
}

export interface EstimatorDeps {
  engine: TtsEngine;
  calibration: SpeedCalibration;
  /** The worker count in use. */
  workers: () => number;
  poolPaused: () => boolean;
  /** Seconds the speed test is expected to hold the pool for yet, or null when it is not holding it. */
  speedTestSeconds?: () => number | null;
}

/** A book read in a language other than the one stored, as the preview asks for. */
export interface LanguageOverride {
  bookId: string;
  language: string;
  /** Prepared characters of each chapter in that language. */
  chars: readonly number[];
}

/**
 * Turns the speed model of each voice and the books' chapters into the numbers the pages show:
 * how long a book is, how long converting it takes, and how long is left. Pure reads, no state.
 */
export class Estimator {
  constructor(private readonly deps: EstimatorDeps) {}

  modelFor(language: string): SpeedModel | null {
    const voice = pickVoice(this.deps.engine, language);
    return voice ? this.deps.calibration.modelFor(this.deps.engine.id, voice) : null;
  }

  /** Estimates for every book that is not finished, by book id. */
  forBooks(load: readonly BookLoad[], override?: LanguageOverride): Map<string, BookEstimates> {
    const { workers: workerCount, poolPaused } = this.deps;
    const workers = workerCount();
    const paused = poolPaused();
    const speedTest = this.deps.speedTestSeconds?.() ?? null;
    const models = new Map<string, SpeedModel | null>();
    const modelOf = (language: string) => {
      if (!models.has(language)) models.set(language, this.modelFor(language));
      return models.get(language) ?? null;
    };

    interface Prepared {
      book: BookLoad;
      model: SpeedModel;
      remaining: number[];
      remainingSeconds: number;
      generating: boolean;
    }
    const prepared: Prepared[] = [];
    for (const original of load) {
      const book =
        override?.bookId === original.bookId
          ? {
              ...original,
              language: override.language,
              chapters: original.chapters.map((c, i) => ({
                ...c,
                preparedChars: override.chars[i] ?? c.preparedChars,
                counted: true,
              })),
            }
          : original;
      const model = modelOf(book.language);
      if (!model) continue;
      const remaining = remainingAudio(model, book.chapters);
      prepared.push({
        book,
        model,
        remaining,
        remainingSeconds: conversionSeconds(model, remaining, workers),
        generating: book.chapters.some((c) => c.status === "generating"),
      });
    }

    const queueFor = (ahead: Prepared[]): QueueView => ({
      booksAhead: ahead.length,
      startsInSeconds:
        ahead.length === 0 || paused
          ? null
          : ahead.reduce((sum, other) => sum + other.remainingSeconds, 0),
    });

    const result = new Map<string, BookEstimates>();
    for (const [index, entry] of prepared.entries()) {
      const { book, model } = entry;
      const all = book.chapters.map((c) => audioSecondsFor(model, c.preparedChars));
      // Ahead of a book that is not queued: everything converting. Otherwise: the converting books before it.
      const ahead = prepared.filter(
        (other, i) =>
          other.book.status === "converting" &&
          other.remainingSeconds > 0 &&
          (book.status === "ready" || i < index),
      );
      const estimate: BookEstimateView = {
        audioSeconds: all.reduce((sum, seconds) => sum + seconds, 0),
        convertSeconds: conversionSeconds(model, all, workers),
        source: model.source,
        workers,
        queue: book.status === "ready" ? queueFor(ahead) : { booksAhead: 0, startsInSeconds: null },
      };
      let timeLeft: TimeLeftView | null = null;
      if (book.status === "converting" || book.status === "paused") {
        const queue = queueFor(ahead);
        const waiting = queue.booksAhead > 0 && !entry.generating;
        const held = speedTest !== null && !entry.generating;
        timeLeft = {
          ...queue,
          state:
            book.status === "paused"
              ? "paused"
              : paused
                ? "pool_paused"
                : held
                  ? "waiting_for_speed_test"
                  : waiting
                    ? "waiting"
                    : "running",
          remainingSeconds: book.status === "paused" || paused ? null : entry.remainingSeconds,
          speedTestSeconds: !paused && book.status === "converting" && held ? speedTest : null,
          source: model.source,
        };
        // A book that is already being read is not waiting behind anyone.
        if (!waiting) timeLeft = { ...timeLeft, booksAhead: 0, startsInSeconds: null };
      }
      const measuring = book.chapters.some((c) => !c.counted);
      result.set(book.bookId, { estimate, measuring, timeLeft, speed: model });
    }
    return result;
  }
}
