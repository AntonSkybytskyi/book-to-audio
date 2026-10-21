import type Database from "better-sqlite3";

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  language: string;
  status: BookStatus;
  coverMime: string | null;
  coverPath: string | null;
  sourcePath: string;
  createdAt: string;
}

export interface BookTotals {
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  durationSeconds: number;
}

export type BookWithTotals = Book & BookTotals;

export interface Chapter {
  position: number;
  title: string;
  charCount: number;
  wordCount: number;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  audioPath: string | null;
  durationSeconds: number | null;
}

export interface NewBook {
  id: string;
  title: string;
  author: string | null;
  language: string;
  coverMime: string | null;
  coverPath: string | null;
  sourcePath: string;
}

export interface NewChapter {
  title: string;
  text: string;
  wordCount: number;
}

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  language: string;
  status: BookStatus;
  cover_mime: string | null;
  cover_path: string | null;
  source_path: string;
  created_at: string;
}

interface TotalsRow extends BookRow {
  chapter_count: number;
  done_count: number;
  failed_count: number;
  word_count: number;
  duration_seconds: number;
}

interface ChapterRow {
  position: number;
  title: string;
  char_count: number;
  word_count: number;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  audio_path: string | null;
  duration_seconds: number | null;
}

const toBook = (row: BookRow): Book => ({
  id: row.id,
  title: row.title,
  author: row.author,
  language: row.language,
  status: row.status,
  coverMime: row.cover_mime,
  coverPath: row.cover_path,
  sourcePath: row.source_path,
  createdAt: row.created_at,
});

const toChapter = (row: ChapterRow): Chapter => ({
  position: row.position,
  title: row.title,
  charCount: row.char_count,
  wordCount: row.word_count,
  status: row.status,
  progress: row.progress,
  error: row.error,
  audioPath: row.audio_path,
  durationSeconds: row.duration_seconds,
});

const TOTALS_SQL = `
  SELECT b.*,
    count(c.id) AS chapter_count,
    coalesce(sum(c.status = 'done'), 0) AS done_count,
    coalesce(sum(c.status = 'failed'), 0) AS failed_count,
    coalesce(sum(c.word_count), 0) AS word_count,
    coalesce(sum(c.duration_seconds), 0) AS duration_seconds
  FROM books b LEFT JOIN chapters c ON c.book_id = b.id
`;

const toTotals = (row: TotalsRow): BookWithTotals => ({
  ...toBook(row),
  chapterCount: row.chapter_count,
  doneCount: row.done_count,
  failedCount: row.failed_count,
  wordCount: row.word_count,
  durationSeconds: row.duration_seconds,
});

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class BookRepository {
  constructor(private readonly db: Database.Database) {}

  insert(book: NewBook, chapters: readonly NewChapter[]): void {
    const insertBook = this.db.prepare(
      `INSERT INTO books (id, title, author, language, cover_mime, cover_path, source_path)
       VALUES (@id, @title, @author, @language, @coverMime, @coverPath, @sourcePath)`,
    );
    const insertChapter = this.db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertBook.run(book);
      chapters.forEach((c, i) =>
        insertChapter.run(book.id, i + 1, c.title, c.text, c.text.length, c.wordCount),
      );
    })();
  }

  get(id: string): BookWithTotals | undefined {
    const row = this.db.prepare(`${TOTALS_SQL} WHERE b.id = ? GROUP BY b.id`).get(id) as
      | TotalsRow
      | undefined;
    return row && toTotals(row);
  }

  /** Newest first. */
  list(): BookWithTotals[] {
    const rows = this.db
      .prepare(`${TOTALS_SQL} GROUP BY b.id ORDER BY b.created_at DESC, b.rowid DESC`)
      .all() as TotalsRow[];
    return rows.map(toTotals);
  }

  chapters(bookId: string): Chapter[] {
    const rows = this.db
      .prepare(
        `SELECT position, title, char_count, word_count, status, progress, error, audio_path,
                duration_seconds
         FROM chapters WHERE book_id = ? ORDER BY position`,
      )
      .all(bookId) as ChapterRow[];
    return rows.map(toChapter);
  }

  chapter(bookId: string, position: number): Chapter | undefined {
    const row = this.db
      .prepare(
        `SELECT position, title, char_count, word_count, status, progress, error, audio_path,
                duration_seconds
         FROM chapters WHERE book_id = ? AND position = ?`,
      )
      .get(bookId, position) as ChapterRow | undefined;
    return row && toChapter(row);
  }

  /** Changes the language of a book that has not started converting. */
  setLanguage(id: string, language: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE books SET language = ?, updated_at = ${NOW} WHERE id = ? AND status = 'ready'`,
      )
      .run(language, id);
    return result.changes > 0;
  }

  /** Moves a `ready` book to `converting` and queues all its chapters. */
  queue(id: string): boolean {
    return this.db
      .transaction(() => {
        const result = this.db
          .prepare(
            `UPDATE books SET status = 'converting', queued_at = ${NOW}, updated_at = ${NOW}
             WHERE id = ? AND status = 'ready'`,
          )
          .run(id);
        if (result.changes === 0) return false;
        this.db
          .prepare(
            `UPDATE chapters SET status = 'queued', progress = 0, error = NULL, updated_at = ${NOW}
             WHERE book_id = ?`,
          )
          .run(id);
        return true;
      })
      .immediate();
  }
}
