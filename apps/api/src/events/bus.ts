import type { BookStatus, ChapterStatus } from "../books/repository.js";
import type { BenchmarkStatus } from "../benchmark/status.js";
import type { OutputsView } from "../outputs/view.js";

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

export interface PoolEvent {
  type: "pool";
  state: "running" | "paused";
  /** Why the pool paused. */
  error: string | null;
  cause: "failures" | "disk" | null;
  workers: number;
  activeWorkers: number;
  /** The speed benchmark has the pool: no new chapter starts until it is done. */
  held: boolean;
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
/** `seq` grows with every event, so a client can tell which of two states is newer. */
export type Listener = (event: AppEvent, seq: number) => void;

/**
 * In-process publish and subscribe. The queue and pool publish; the SSE route subscribes.
 * Sequence numbers start from the boot time, so they also grow across restarts: a client that
 * reconnects to a restarted server never mistakes the new events for old ones.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private seq: number;

  constructor(now: () => number = Date.now) {
    this.seq = Math.floor(now() / 1000) * 1_000_000;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** The sequence number of the latest event. */
  get currentSeq(): number {
    return this.seq;
  }

  /** Returns the function that removes the listener. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AppEvent): void {
    const seq = ++this.seq;
    for (const listener of this.listeners) {
      try {
        listener(event, seq);
      } catch {
        // One broken subscriber (a closed socket, say) must not stop the others.
      }
    }
  }
}
