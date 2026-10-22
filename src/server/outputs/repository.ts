import type Database from "better-sqlite3";
import type { OutputRow, OutputState } from "./view.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

interface Row {
  state: OutputState;
  progress: number;
  error: string | null;
  built_generation: number | null;
  attempt_generation: number | null;
  m4b_bytes: number | null;
  zip_bytes: number | null;
}

/**
 * The `book_outputs` table. Every change is one SQL statement, and the one that makes files
 * current (`complete`) compares the book's audio generation in the same statement, so a chapter
 * written while the build ran can never be recorded as covered by it.
 */
export class OutputRepository {
  constructor(private readonly db: Database.Database) {}

  get(bookId: string): OutputRow | undefined {
    const row = this.db
      .prepare(
        `SELECT state, progress, error, built_generation, attempt_generation, m4b_bytes, zip_bytes
         FROM book_outputs WHERE book_id = ?`,
      )
      .get(bookId) as Row | undefined;
    return row && toRow(row);
  }

  /** Books whose build was interrupted, oldest request first. */
  unfinished(): string[] {
    return this.db
      .prepare(
        `SELECT book_id FROM book_outputs WHERE state IN ('queued', 'building')
         ORDER BY queued_at, rowid`,
      )
      .pluck()
      .all() as string[];
  }

  /** Ids of finished books, oldest first, for the startup check. */
  doneBookIds(): string[] {
    return this.db
      .prepare("SELECT id FROM books WHERE status = 'done' ORDER BY created_at, rowid")
      .pluck()
      .all() as string[];
  }

  /** Asks for a build. The files and sizes of an earlier build stay until a new one replaces them. False when the book is gone. */
  enqueue(bookId: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO book_outputs (book_id, state) SELECT id, 'queued' FROM books WHERE id = ?
           ON CONFLICT (book_id) DO UPDATE SET state = 'queued', progress = 0, error = NULL,
             queued_at = ${NOW}, updated_at = ${NOW}`,
        )
        .run(bookId).changes > 0
    );
  }

  /** The build starts from `generation` of the book's audio. False when the book or the request is gone. */
  begin(bookId: string, generation: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE book_outputs SET state = 'building', progress = 0, error = NULL,
             attempt_generation = ?, updated_at = ${NOW}
           WHERE book_id = ? AND state = 'queued'`,
        )
        .run(generation, bookId).changes > 0
    );
  }

  progress(bookId: string, fraction: number): void {
    this.db
      .prepare(
        `UPDATE book_outputs SET progress = ?, updated_at = ${NOW} WHERE book_id = ? AND state = 'building'`,
      )
      .run(Math.min(1, Math.max(0, fraction)), bookId);
  }

  /**
   * Records the finished files, if and only if the book's audio is still at `generation` and the
   * book is still done. False means the audio changed (or the book was deleted) while building:
   * the files must not be offered.
   */
  complete(
    bookId: string,
    built: { generation: number; m4bBytes: number; zipBytes: number },
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE book_outputs SET state = 'ready', progress = 1, error = NULL,
             built_generation = @generation, m4b_bytes = @m4bBytes, zip_bytes = @zipBytes,
             updated_at = ${NOW}
           WHERE book_id = @bookId AND state = 'building'
             AND (SELECT audio_generation FROM books WHERE id = @bookId) = @generation
             AND (SELECT status FROM books WHERE id = @bookId) = 'done'`,
        )
        .run({ bookId, ...built }).changes > 0
    );
  }

  fail(bookId: string, error: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE book_outputs SET state = 'failed', error = ?, updated_at = ${NOW}
           WHERE book_id = ? AND state IN ('queued', 'building')`,
        )
        .run(error, bookId).changes > 0
    );
  }

  /**
   * The files this row describes are not on the disk (any more): forget that they were built, so
   * they are not offered. The state stays; a build that is queued or running goes on and records
   * itself as usual.
   */
  invalidate(bookId: string): void {
    this.db
      .prepare(
        `UPDATE book_outputs SET built_generation = NULL, m4b_bytes = NULL, zip_bytes = NULL,
           updated_at = ${NOW} WHERE book_id = ?`,
      )
      .run(bookId);
  }

  /**
   * Takes a request or build that did not finish back to what the files on disk are: `ready`
   * (stale or not, the generation comparison says which) when an earlier build left files, or no
   * row at all.
   */
  withdraw(bookId: string): void {
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE book_outputs SET state = 'ready', progress = 1, error = NULL, updated_at = ${NOW}
           WHERE book_id = ? AND state IN ('queued', 'building') AND built_generation IS NOT NULL`,
        )
        .run(bookId).changes;
      if (changed === 0) {
        this.db
          .prepare("DELETE FROM book_outputs WHERE book_id = ? AND state IN ('queued', 'building')")
          .run(bookId);
      }
    })();
  }
}

const toRow = (row: Row): OutputRow => ({
  state: row.state,
  progress: row.progress,
  error: row.error,
  builtGeneration: row.built_generation,
  attemptGeneration: row.attempt_generation,
  m4bBytes: row.m4b_bytes,
  zipBytes: row.zip_bytes,
});
