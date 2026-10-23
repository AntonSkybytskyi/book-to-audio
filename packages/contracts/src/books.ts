import type { SpeedModel, SpeedSource } from "./estimate.js";
import type { LanguageSource } from "./languages.js";

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";

/** A chapter as the API returns it. Never includes file paths or chapter text. */
export interface ChapterView {
  position: number;
  title: string;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  charCount: number;
  wordCount: number;
  /** Characters the engine is given for the chapter; what the time estimates are made from. */
  preparedChars: number;
  /** How long the chapter will be read aloud, before it is done; null when no voice could say. */
  estimatedSeconds: number | null;
  durationSeconds: number | null;
  /** Chunks the chapter is split into (0 until it starts) and how many are finished. */
  chunkCount: number;
  chunksDone: number;
  /** There is audio to play: also true while the chapter is regenerated, or after a failed retry. */
  hasAudio: boolean;
  /** Changes when the audio is replaced; the player puts it in the audio URL. */
  audioVersion: number;
  /** Why the last regeneration failed. The chapter is `done` and kept its previous audio. */
  regenError: string | null;
}

export type OutputState = "queued" | "building" | "ready" | "failed";

/** What the API and the live events say about a book's downloads (the M4B and the ZIP). */
export interface OutputsView {
  /** `none` until a build was ever wanted. */
  state: "none" | OutputState;
  /** The files can be downloaded now: built from the book's current audio, and the book is done. A rebuild of the same audio does not change that. */
  available: boolean;
  /** Files built from older audio exist and new ones are on their way (or waiting for the book to be done again). */
  updating: boolean;
  /** 0 to 1, while building. */
  progress: number;
  error: string | null;
  /** Only while `available`. */
  m4bBytes: number | null;
  zipBytes: number | null;
}

/** A book that was never built. */
export const NO_OUTPUTS: OutputsView = {
  state: "none",
  available: false,
  updating: false,
  progress: 0,
  error: null,
  m4bBytes: null,
  zipBytes: null,
};

/** Who is ahead of a book in the queue, and how long until its turn. */
export interface QueueView {
  booksAhead: number;
  /** Null when nothing is ahead, or the pool is paused and no one can say. */
  startsInSeconds: number | null;
}

/** Length and conversion time of a book that is not finished. */
export interface BookEstimateView {
  /** The whole book read aloud. */
  audioSeconds: number;
  /** Converting it from the start with the workers in use. */
  convertSeconds: number;
  source: SpeedSource;
  /** The TTS service that reads the book's language. */
  service: string;
  /** Workers of that service. */
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

/** Time left of a converting or paused book. */
export interface TimeLeftView extends QueueView {
  state: TimeLeftState;
  /** Until this book is done, once it starts; null while paused. Failed chapters are not counted. */
  remainingSeconds: number | null;
  /** While `waiting_for_speed_test`: how long the speed test is expected to take yet. */
  speedTestSeconds: number | null;
  source: SpeedSource;
}

/** A book in the library list. */
export interface BookSummaryView {
  id: string;
  title: string;
  author: string | null;
  language: string;
  /** How `language` was found: from the text, the metadata, not at all, or chosen by the owner. */
  languageSource: LanguageSource;
  languageConfidence: number;
  /** The supported language the book's metadata names, if any. */
  declaredLanguage: string | null;
  status: BookStatus;
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  /** Length and conversion time for a book that is not finished; null once it is, without a voice, or while measuring. */
  estimate: BookEstimateView | null;
  /** The text is still being counted, so there is no estimate yet; it arrives by itself (`book-counted`). */
  measuring: boolean;
  /** Only while the book is converting or paused. */
  timeLeft: TimeLeftView | null;
  durationSeconds: number;
  /** The M4B and ZIP: whether they can be downloaded, are being built or failed. */
  outputs: OutputsView;
}

/** A book with its chapters: `GET /api/books/:id` and the answer to every change of a book. */
export interface BookView extends BookSummaryView {
  /** The speed behind `estimate`, so the page can keep the time left current as chapters progress. */
  speed: SpeedModel | null;
  chapters: ChapterView[];
  /** Languages the TTS engine has a voice for. */
  availableLanguages: string[];
}

/** `GET /api/books`. */
export interface BookListView {
  books: BookSummaryView[];
}

/** `GET /api/books/:id/estimate?language=`: a book that is not converted yet, as if read in that language. */
export interface LanguageEstimateView {
  estimate: BookEstimateView | null;
  speed: SpeedModel | null;
  /** Seconds of audio expected for each chapter, in reading order. */
  chapterSeconds: number[];
  /** The book's own text has not been counted yet: ask again when the page is told it has. */
  measuring: boolean;
}
