import type Database from "better-sqlite3";

/**
 * The characters of prepared text of each chapter (`chapters.prepared_chars`, migration 8): what the
 * time estimates are made from, counted in the background after an upload or a change of language.
 */
export class CountRepository {
  constructor(private readonly db: Database.Database) {}

  /** The text of each chapter of a book, in reading order. */
  chapterTexts(bookId: string): string[] {
    return this.db
      .prepare("SELECT text FROM chapters WHERE book_id = ? ORDER BY position")
      .pluck()
      .all(bookId) as string[];
  }

  /** The chapters of a book that have no count, or only a stand-in for one, with their text. */
  pending(bookId: string): { position: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT position, text FROM chapters
         WHERE book_id = ? AND (prepared_chars IS NULL OR prepared_approx = 1) ORDER BY position`,
      )
      .all(bookId) as { position: number; text: string }[];
  }

  /** The language of a book, or undefined when there is no such book. */
  bookLanguage(id: string): string | undefined {
    return this.db.prepare("SELECT language FROM books WHERE id = ?").pluck().get(id) as
      | string
      | undefined;
  }

  /**
   * Saves counts by chapter position, but only if the book still exists and is in `language`, and only
   * where no exact count is set: a count that was made for another language (the owner changed it
   * meanwhile) is dropped. `approx` marks a stand-in (the raw length) that is counted again later.
   * Returns whether it was saved.
   */
  setCounts(
    bookId: string,
    language: string,
    counts: readonly { position: number; chars: number; approx: boolean }[],
  ): boolean {
    const update = this.db.prepare(
      `UPDATE chapters SET prepared_chars = ?, prepared_approx = ?
       WHERE book_id = ? AND position = ? AND (prepared_chars IS NULL OR prepared_approx = 1)`,
    );
    return this.db
      .transaction(() => {
        if (this.bookLanguage(bookId) !== language) return false;
        for (const { position, chars, approx } of counts) {
          update.run(chars, approx ? 1 : 0, bookId, position);
        }
        return true;
      })
      .immediate();
  }

  /** Books that are not finished and have a chapter with no count or only a stand-in. */
  uncountedBookIds(): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT c.book_id FROM chapters c JOIN books b ON b.id = c.book_id
         WHERE (c.prepared_chars IS NULL OR c.prepared_approx = 1)
           AND b.status IN ('ready', 'converting', 'paused')`,
      )
      .pluck()
      .all() as string[];
  }

  /**
   * Forgets the counts of unfinished books when the text rules are not the ones that made them (the
   * version is kept in `app_meta`), so they are counted again. Says whether the version was the same,
   * had not been recorded yet (counts of an unknown version are forgotten too), or had changed.
   */
  resetCountsIfRulesChanged(version: number): "same" | "recorded" | "changed" {
    return this.db
      .transaction((): "same" | "recorded" | "changed" => {
        const key = "prepared_chars_version";
        const saved = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").pluck().get(key);
        if (saved === String(version)) return "same";
        this.db
          .prepare(
            `UPDATE chapters SET prepared_chars = NULL, prepared_approx = 0 WHERE book_id IN
               (SELECT id FROM books WHERE status IN ('ready', 'converting', 'paused'))`,
          )
          .run();
        this.db
          .prepare(
            `INSERT INTO app_meta (key, value) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          )
          .run(key, String(version));
        return saved === undefined ? "recorded" : "changed";
      })
      .immediate();
  }
}
