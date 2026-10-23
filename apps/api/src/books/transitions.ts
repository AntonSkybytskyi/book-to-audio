import type Database from "better-sqlite3";
import type { ChapterQueue } from "./queue.js";
import type { BookStatus } from "./repository.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface Restarted {
  /** Chapters that were put back in the queue. */
  positions: number[];
  /** The book's status afterwards. */
  status: BookStatus;
}

/**
 * The status changes the owner makes by hand: pause, resume, regenerate and delete.
 * Each is one guarded SQL statement or transaction, so the status a request saw is the
 * status it changed from; the workers' own transitions stay in `ChapterQueue`.
 *
 * Regenerating takes two steps around the awaited abort in `WorkerPool`. `suspend` first
 * takes the chapters out of the queue and makes any running attempt stale (the row stays
 * `generating` with a newer claim and no worker, which nothing will claim). Once the workers
 * have stopped and the chunks are discarded, `restart` queues the chapters again.
 */
export class BookTransitions {
  constructor(
    private readonly db: Database.Database,
    private readonly queue: ChapterQueue,
  ) {}

  /** `converting` to `paused`. Running chapters finish; no new one is claimed. */
  pause(bookId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE books SET status = 'paused', updated_at = ${NOW} WHERE id = ? AND status = 'converting'`,
        )
        .run(bookId).changes > 0
    );
  }

  /**
   * `paused` to `converting`, keeping the book's place in the queue, or straight to its final
   * status when nothing is left to convert. Returns the new status, or null if it was not paused.
   */
  resume(bookId: string): BookStatus | null {
    return this.db
      .transaction((): BookStatus | null => {
        const changed = this.db
          .prepare(
            `UPDATE books SET status = 'converting', updated_at = ${NOW} WHERE id = ? AND status = 'paused'`,
          )
          .run(bookId).changes;
        return changed > 0 ? this.queue.refreshBookStatus(bookId) : null;
      })
      .immediate();
  }

  /**
   * Takes a book's queued and running chapters (or just one running chapter) out of the
   * workers' reach, and makes the running attempts stale. Returns the ids of the chapters
   * that were running or queued, so the caller can abort them.
   */
  suspend(bookId: string, position?: number): number[] {
    return this.db
      .transaction(() => {
        const ids = this.db
          .prepare(
            `SELECT id FROM chapters WHERE book_id = @bookId AND (
               (@position IS NULL AND status IN ('queued', 'generating'))
               OR (position = @position AND status = 'generating'))`,
          )
          .pluck()
          .all({ bookId, position: position ?? null }) as number[];
        const hold = this.db.prepare(
          `UPDATE chapters SET status = 'generating', claim = claim + 1, updated_at = ${NOW}
           WHERE id = ?`,
        );
        for (const id of ids) hold.run(id);
        return ids;
      })
      .immediate();
  }

  /**
   * Puts a chapter (or every chapter that has been started) back in the queue. A `fresh`
   * restart forgets the saved chunks' count, otherwise the chapter resumes from them; the
   * caller removes the chunk files for a fresh restart before calling. A chapter's audio and
   * length stay until its new audio replaces them. A finished book becomes `converting` again
   * and joins the back of the queue; a converting or paused book keeps its place. Returns
   * null for a book that does not exist or has not been queued. With `ids`, only those chapters
   * (rows by id) are restarted.
   */
  restart(
    bookId: string,
    scope: { position?: number; fresh: boolean; ids?: readonly number[] },
  ): Restarted | null {
    return this.db
      .transaction((): Restarted | null => {
        const book = this.db.prepare("SELECT status FROM books WHERE id = ?").get(bookId) as
          | { status: BookStatus }
          | undefined;
        if (!book || book.status === "ready") return null;

        const rows = this.db
          .prepare(
            `SELECT id, position FROM chapters WHERE book_id = @bookId AND status != 'pending'
               AND (@position IS NULL OR (position = @position AND status != 'queued'))
             ORDER BY position`,
          )
          .all({ bookId, position: scope.position ?? null }) as { id: number; position: number }[];
        const ids = scope.ids ? new Set(scope.ids) : null;
        const positions = rows.filter((row) => !ids || ids.has(row.id)).map((row) => row.position);
        const reset = this.db.prepare(
          `UPDATE chapters SET status = 'queued', error = NULL, regen_error = NULL, claim = claim + 1,
             progress = CASE WHEN @fresh THEN 0 ELSE progress END,
             chunk_count = CASE WHEN @fresh THEN 0 ELSE chunk_count END,
             chunks_done = CASE WHEN @fresh THEN 0 ELSE chunks_done END,
             updated_at = ${NOW}
           WHERE book_id = @bookId AND position = @position`,
        );
        for (const position of positions) {
          reset.run({ bookId, position, fresh: scope.fresh ? 1 : 0 });
        }

        let status = book.status;
        if (positions.length > 0 && (status === "done" || status === "done_with_errors")) {
          this.db
            .prepare(
              `UPDATE books SET status = 'converting', queued_at = ${NOW}, updated_at = ${NOW}
               WHERE id = ?`,
            )
            .run(bookId);
          status = "converting";
        }
        return { positions, status };
      })
      .immediate();
  }

  /** Deletes the book and, by cascade, its chapters. Returns false if there was no such book. */
  remove(bookId: string): boolean {
    return this.db.prepare("DELETE FROM books WHERE id = ?").run(bookId).changes > 0;
  }
}
