import type { BenchmarkStatus } from "./benchmark.js";
import type { BookStatus, ChapterStatus, OutputsView } from "./books.js";
import type { PoolStatus } from "./pool.js";

/** Small JSON payloads for the live updates in `GET /api/events`. */
export interface ChapterEvent {
  type: "chapter";
  bookId: string;
  position: number;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  durationSeconds: number | null;
  /** Chunks the chapter is split into and how many are finished; equal while it is being joined. */
  chunkCount: number;
  chunksDone: number;
  /** Set when the chapter's audio was written; null in every other event. */
  audioVersion: number | null;
  /** Set when a regeneration failed and the chapter went back to `done` with its old audio. */
  regenError: string | null;
}

export interface BookEvent {
  type: "book";
  bookId: string;
  status: BookStatus;
  doneCount: number;
  failedCount: number;
  durationSeconds: number;
}

/** The pool's state; also the first message of every stream. */
export interface PoolEvent extends PoolStatus {
  type: "pool";
}

export interface BookAddedEvent {
  type: "book-added";
  bookId: string;
}

/** Sent after the book and all its files are gone; no event about this book follows. */
export interface BookDeletedEvent {
  type: "book-deleted";
  bookId: string;
}

/** The state of a book's downloads changed (progress is throttled). */
export interface OutputsEvent extends OutputsView {
  type: "outputs";
  bookId: string;
}

/** The speed benchmark started, moved on or ended. */
export interface BenchmarkEvent extends BenchmarkStatus {
  type: "benchmark";
}

/** The prepared text of a book was counted, so its length and conversion time can be told now. */
export interface BookCountedEvent {
  type: "book-counted";
  bookId: string;
}

export type AppEvent =
  | ChapterEvent
  | BookEvent
  | PoolEvent
  | BookAddedEvent
  | BookDeletedEvent
  | OutputsEvent
  | BenchmarkEvent
  | BookCountedEvent;

/** Every event type, for a client that has to name the ones it listens to. */
export const EVENT_TYPES = [
  "chapter",
  "book",
  "pool",
  "book-added",
  "book-deleted",
  "outputs",
  "benchmark",
  "book-counted",
] as const satisfies readonly AppEvent["type"][];

// Fails to compile when an event type is missing from EVENT_TYPES.
const everyEventListed: Exclude<AppEvent["type"], (typeof EVENT_TYPES)[number]> extends never
  ? true
  : never = true;
void everyEventListed;
