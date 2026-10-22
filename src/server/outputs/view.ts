import type { BookStatus } from "../books/repository.js";

export type OutputState = "queued" | "building" | "ready" | "failed";

/** The `book_outputs` row of a book. */
export interface OutputRow {
  state: OutputState;
  progress: number;
  error: string | null;
  /** The book's audio generation the files on disk were built from; null when there are none. */
  builtGeneration: number | null;
  attemptGeneration: number | null;
  m4bBytes: number | null;
  zipBytes: number | null;
}

/** What the API and the live events say about a book's downloads. */
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

export const NO_OUTPUTS: OutputsView = {
  state: "none",
  available: false,
  updating: false,
  progress: 0,
  error: null,
  m4bBytes: null,
  zipBytes: null,
};

/**
 * The generation protocol in one place: the files are current only when a build recorded the
 * generation the book has now, and the book is done. Anything else, a regenerated chapter
 * included, makes them stale at once, without anybody having to notice. The state of the row
 * does not matter for that: a rebuild or a retry of the same audio (queued, building, even failed)
 * leaves the files that are there valid, and they stay on offer until the new ones replace them.
 */
export function toOutputsView(
  status: BookStatus,
  audioGeneration: number,
  row: OutputRow | null | undefined,
): OutputsView {
  if (!row) return NO_OUTPUTS;
  const available = status === "done" && row.builtGeneration === audioGeneration;
  return {
    state: row.state,
    available,
    updating: !available && row.builtGeneration !== null,
    progress: row.state === "ready" ? 1 : row.progress,
    // Also while the files of the same audio are on offer: a failed rebuild says so next to them.
    error: row.state === "failed" ? row.error : null,
    m4bBytes: available ? row.m4bBytes : null,
    zipBytes: available ? row.zipBytes : null,
  };
}
