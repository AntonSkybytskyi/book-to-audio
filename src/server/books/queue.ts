import type Database from "better-sqlite3";
import type { BookStatus } from "./repository.js";

export interface ClaimedChapter {
  id: number;
  bookId: string;
  position: number;
  title: string;
  text: string;
  language: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Chapter task queue on top of the `chapters` table. Slice 2 replaces the picking logic. */
export class ChapterQueue {
  constructor(private readonly db: Database.Database) {}

  /** Chapters left `generating` by a crash or restart go back to `queued`. */
  resetInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE chapters SET status = 'queued', progress = 0, updated_at = ${NOW}
         WHERE status = 'generating'`,
      )
      .run().changes;
  }

  /** Takes the next queued chapter, earliest queued book first, then by position. */
  claimNext(): ClaimedChapter | null {
    return this.db
      .transaction((): ClaimedChapter | null => {
        const row = this.db
          .prepare(
            `SELECT c.id, c.book_id, c.position, c.title, c.text, b.language
             FROM chapters c JOIN books b ON b.id = c.book_id
             WHERE c.status = 'queued' AND b.status = 'converting'
             ORDER BY b.queued_at, b.rowid, c.position LIMIT 1`,
          )
          .get() as
          | {
              id: number;
              book_id: string;
              position: number;
              title: string;
              text: string;
              language: string;
            }
          | undefined;
        if (!row) return null;
        this.db
          .prepare(
            `UPDATE chapters SET status = 'generating', progress = 0, error = NULL,
               updated_at = ${NOW} WHERE id = ?`,
          )
          .run(row.id);
        return {
          id: row.id,
          bookId: row.book_id,
          position: row.position,
          title: row.title,
          text: row.text,
          language: row.language,
        };
      })
      .immediate();
  }

  setProgress(id: number, progress: number): void {
    this.db
      .prepare(`UPDATE chapters SET progress = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(Math.min(1, Math.max(0, progress)), id);
  }

  markDone(id: number, audioPath: string, durationSeconds: number): void {
    this.db
      .prepare(
        `UPDATE chapters SET status = 'done', progress = 1, error = NULL, audio_path = ?,
           duration_seconds = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(audioPath, durationSeconds, id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare(`UPDATE chapters SET status = 'failed', error = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(error, id);
  }

  /** Puts a chapter back in the queue, for example when the server is shutting down. */
  requeue(id: number): void {
    this.db
      .prepare(
        `UPDATE chapters SET status = 'queued', progress = 0, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(id);
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

  /** Settles books whose last chapter finished just before a restart. */
  refreshAllConverting(): void {
    const ids = this.db.prepare("SELECT id FROM books WHERE status = 'converting'").pluck().all();
    for (const id of ids as string[]) this.refreshBookStatus(id);
  }
}
