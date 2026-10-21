import type Database from "better-sqlite3";
import type { BookStatus } from "./repository.js";

export interface ClaimedChapter {
  id: number;
  bookId: string;
  position: number;
  title: string;
  text: string;
  language: string;
  /**
   * Identifies this attempt. Every update below is applied only while it is still
   * the chapter's current claim, so a worker that was cancelled, or whose chapter
   * was re-queued and taken by another, cannot overwrite the newer attempt.
   */
  claim: number;
  /** Chunks the chapter is split into; 0 until a worker has recorded it. */
  chunkCount: number;
  /** Chunks recorded as finished by an earlier attempt. */
  chunksDone: number;
}

export interface BookCounts {
  status: BookStatus;
  doneCount: number;
  failedCount: number;
  durationSeconds: number;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// The row that `claim` still refers to.
const OWN = "id = @id AND status = 'generating' AND claim = @claim";

interface ClaimRow {
  id: number;
  book_id: string;
  position: number;
  title: string;
  text: string;
  language: string;
  claim: number;
  chunk_count: number;
  chunks_done: number;
}

/**
 * Chapter task queue on top of the `chapters` table. All state changes are single
 * SQL statements; the updates for a running chapter return false when the claim
 * is stale, and the caller then drops its result.
 */
export class ChapterQueue {
  constructor(private readonly db: Database.Database) {}

  /** Chapters left `generating` by a crash or restart go back to `queued`, keeping their chunks. */
  resetInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE chapters SET status = 'queued', updated_at = ${NOW} WHERE status = 'generating'`,
      )
      .run().changes;
  }

  /**
   * Takes the next queued chapter: earliest queued book first, then by position.
   * Only books that are `converting` are served, so a book that is paused (or being
   * deleted) is left alone. One write transaction, so two workers can never get
   * the same chapter, even from separate connections.
   */
  claimNext(): ClaimedChapter | null {
    return this.db
      .transaction((): ClaimedChapter | null => {
        const row = this.db
          .prepare(
            `SELECT c.id, c.book_id, c.position, c.title, c.text, b.language, c.claim,
                    c.chunk_count, c.chunks_done
             FROM chapters c JOIN books b ON b.id = c.book_id
             WHERE c.status = 'queued' AND b.status = 'converting'
             ORDER BY b.queued_at, b.rowid, c.position LIMIT 1`,
          )
          .get() as ClaimRow | undefined;
        if (!row) return null;
        const claim = row.claim + 1;
        this.db
          .prepare(
            `UPDATE chapters SET status = 'generating', claim = ?, error = NULL,
               updated_at = ${NOW} WHERE id = ?`,
          )
          .run(claim, row.id);
        return {
          id: row.id,
          bookId: row.book_id,
          position: row.position,
          title: row.title,
          text: row.text,
          language: row.language,
          claim,
          chunkCount: row.chunk_count,
          chunksDone: row.chunks_done,
        };
      })
      .immediate();
  }

  /** Saves how many of `total` chunks are finished. Progress is the same fraction. */
  recordChunks(task: ClaimedChapter, done: number, total: number): boolean {
    const progress = total > 0 ? Math.min(1, done / total) : 0;
    return (
      this.db
        .prepare(
          `UPDATE chapters SET chunk_count = @total, chunks_done = @done, progress = @progress,
             updated_at = ${NOW} WHERE ${OWN}`,
        )
        .run({ id: task.id, claim: task.claim, total, done, progress }).changes > 0
    );
  }

  markDone(task: ClaimedChapter, audioPath: string, durationSeconds: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE chapters SET status = 'done', progress = 1, chunks_done = chunk_count,
             error = NULL, audio_path = @audioPath, duration_seconds = @durationSeconds,
             updated_at = ${NOW} WHERE ${OWN}`,
        )
        .run({ id: task.id, claim: task.claim, audioPath, durationSeconds }).changes > 0
    );
  }

  /** The finished chunks stay, so running the chapter again can continue from them. */
  markFailed(task: ClaimedChapter, error: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE chapters SET status = 'failed', error = @error, updated_at = ${NOW} WHERE ${OWN}`,
        )
        .run({ id: task.id, claim: task.claim, error }).changes > 0
    );
  }

  /** Puts a chapter back in the queue, for example when the server is shutting down. */
  requeue(task: ClaimedChapter): boolean {
    return (
      this.db
        .prepare(`UPDATE chapters SET status = 'queued', updated_at = ${NOW} WHERE ${OWN}`)
        .run({ id: task.id, claim: task.claim }).changes > 0
    );
  }

  /** Whether a chapter row points at this audio file. */
  audioInUse(audioPath: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM chapters WHERE audio_path = ?").pluck().get(audioPath) === 1
    );
  }

  bookCounts(bookId: string): BookCounts | null {
    const row = this.db
      .prepare(
        `SELECT b.status, coalesce(sum(c.status = 'done'), 0) AS done,
                coalesce(sum(c.status = 'failed'), 0) AS failed,
                coalesce(sum(c.duration_seconds), 0) AS duration
         FROM books b LEFT JOIN chapters c ON c.book_id = b.id WHERE b.id = ? GROUP BY b.id`,
      )
      .get(bookId) as
      | { status: BookStatus; done: number; failed: number; duration: number }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      doneCount: row.done,
      failedCount: row.failed,
      durationSeconds: row.duration,
    };
  }

  /**
   * Marks a converting book `done` or `done_with_errors` once none of its
   * chapters is waiting or running. Returns the status the book ends up with.
   */
  refreshBookStatus(bookId: string): BookStatus | null {
    return this.db
      .transaction((): BookStatus | null => {
        const book = this.db.prepare("SELECT status FROM books WHERE id = ?").get(bookId) as
          | { status: BookStatus }
          | undefined;
        if (!book) return null;
        if (book.status !== "converting") return book.status;

        const open = this.db
          .prepare(
            `SELECT count(*) FROM chapters WHERE book_id = ? AND status IN ('queued', 'generating')`,
          )
          .pluck()
          .get(bookId) as number;
        if (open > 0) return "converting";

        const failed = this.db
          .prepare(`SELECT count(*) FROM chapters WHERE book_id = ? AND status = 'failed'`)
          .pluck()
          .get(bookId) as number;
        const status: BookStatus = failed > 0 ? "done_with_errors" : "done";
        this.db
          .prepare(`UPDATE books SET status = ?, updated_at = ${NOW} WHERE id = ?`)
          .run(status, bookId);
        return status;
      })
      .immediate();
  }

  /** Ids of the books that are being converted. */
  convertingBookIds(): string[] {
    return this.db
      .prepare("SELECT id FROM books WHERE status = 'converting'")
      .pluck()
      .all() as string[];
  }

  /** Settles books whose last chapter finished just before a restart. */
  refreshAllConverting(): void {
    const ids = this.db.prepare("SELECT id FROM books WHERE status = 'converting'").pluck().all();
    for (const id of ids as string[]) this.refreshBookStatus(id);
  }
}
