import type { StreamEvent } from "@/ui/shared/api/events";
import type { BookStatus, ChapterStatus, Outputs } from "./api";

// Mirrors the payloads in src/server/events/bus.ts.
export interface ChapterEvent {
  type: "chapter";
  bookId: string;
  position: number;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  durationSeconds: number | null;
  chunkCount: number;
  chunksDone: number;
  /** Set when the chapter's audio was written; null in every other event. */
  audioVersion: number | null;
  /** Set when a regeneration failed and the chapter went back to done with its old audio. */
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

export interface BookAddedEvent {
  type: "book-added";
  bookId: string;
}

export interface BookDeletedEvent {
  type: "book-deleted";
  bookId: string;
}

/** The state of a book's downloads changed. */
export interface OutputsEvent extends Outputs {
  type: "outputs";
  bookId: string;
}

/** The prepared text of a book was counted, so its length and conversion time can be told now. */
export interface BookCountedEvent {
  type: "book-counted";
  bookId: string;
}

export type BookLiveEvent =
  | ChapterEvent
  | BookEvent
  | BookAddedEvent
  | BookDeletedEvent
  | OutputsEvent
  | BookCountedEvent;

const BOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "chapter",
  "book",
  "book-added",
  "book-deleted",
  "outputs",
  "book-counted",
]);

export const isBookEvent = (event: StreamEvent): event is BookLiveEvent =>
  BOOK_EVENT_TYPES.has(event.type);
