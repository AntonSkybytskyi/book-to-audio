import type Database from "better-sqlite3";
import type { OutputRow, OutputState } from "../outputs/view.js";
import type { LanguageSource } from "./language-choice.js";

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  language: string;
  /** Where `language` came from, and how sure the text detection was. */
  languageSource: LanguageSource;
  languageConfidence: number;
  /** The supported language the book's metadata names, if any. */
  declaredLanguage: string | null;
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

export type BookWithTotals = Book &
  BookTotals & {
    /** Counts the chapter audio writes of the book (see migration 5). */
    audioGeneration: number;
    /** The state of the M4B and ZIP, null when none was ever wanted. */
    outputs: OutputRow | null;
  };

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
  chunkCount: number;
  chunksDone: number;
  /** Changes whenever the audio file is written again. */
  audioVersion: number;
  /** Why the last regeneration failed; the chapter kept its previous audio. */
  regenError: string | null;
  /** Characters the engine is given for the chapter after the text rules; the raw length until counted. */
  preparedChars: number;
  /** `preparedChars` is a count and not the raw length stand-in. */
  counted: boolean;
}

/** A chapter that still has to be read (or is being read), for time estimates. */
export interface ChapterLoad {
  status: ChapterStatus;
  progress: number;
  preparedChars: number;
  counted: boolean;
}

/** The chapters of a book that is not finished, in reading order. */
export interface BookLoad {
  bookId: string;
  language: string;
  status: BookStatus;
  chapters: ChapterLoad[];
}

export interface NewBook {
  id: string;
  title: string;
  author: string | null;
  language: string;
  /** Where `language` came from; `unknown` when not given. */
  languageSource?: LanguageSource;
  languageConfidence?: number;
  declaredLanguage?: string | null;
  coverMime: string | null;
  coverPath: string | null;
  sourcePath: string;
}

export interface NewChapter {
  title: string;
  text: string;
  wordCount: number;
  /** Characters after the text rules; left out when not counted, and counted later. */
  preparedChars?: number | null;
}

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  language: string;
  language_source: LanguageSource;
  language_confidence: number;
  declared_language: string | null;
  status: BookStatus;
  cover_mime: string | null;
  cover_path: string | null;
  source_path: string;
  created_at: string;
  audio_generation: number;
}

interface TotalsRow extends BookRow {
  chapter_count: number;
  done_count: number;
  failed_count: number;
  word_count: number;
  duration_seconds: number;
  o_state: OutputState | null;
  o_progress: number | null;
  o_error: string | null;
  o_built_generation: number | null;
  o_attempt_generation: number | null;
  o_m4b_bytes: number | null;
  o_zip_bytes: number | null;
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
  chunk_count: number;
  chunks_done: number;
  audio_version: number;
  regen_error: string | null;
  prepared_chars: number;
  counted: number;
}

const toBook = (row: BookRow): Book => ({
  id: row.id,
  title: row.title,
  author: row.author,
  language: row.language,
  languageSource: row.language_source,
  languageConfidence: row.language_confidence,
  declaredLanguage: row.declared_language,
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
  chunkCount: row.chunk_count,
  chunksDone: row.chunks_done,
  audioVersion: row.audio_version,
  regenError: row.regen_error,
  preparedChars: row.prepared_chars,
  counted: row.counted === 1,
});

const TOTALS_SQL = `
  SELECT b.*,
    count(c.id) AS chapter_count,
    coalesce(sum(c.status = 'done'), 0) AS done_count,
    coalesce(sum(c.status = 'failed'), 0) AS failed_count,
    coalesce(sum(c.word_count), 0) AS word_count,
    coalesce(sum(c.duration_seconds), 0) AS duration_seconds,
    o.state AS o_state, o.progress AS o_progress, o.error AS o_error,
    o.built_generation AS o_built_generation, o.attempt_generation AS o_attempt_generation,
    o.m4b_bytes AS o_m4b_bytes, o.zip_bytes AS o_zip_bytes
  FROM books b
    LEFT JOIN chapters c ON c.book_id = b.id
    LEFT JOIN book_outputs o ON o.book_id = b.id
`;

const toTotals = (row: TotalsRow): BookWithTotals => ({
  ...toBook(row),
  chapterCount: row.chapter_count,
  doneCount: row.done_count,
  failedCount: row.failed_count,
  wordCount: row.word_count,
  durationSeconds: row.duration_seconds,
  audioGeneration: row.audio_generation,
  outputs:
    row.o_state === null
      ? null
      : {
          state: row.o_state,
          progress: row.o_progress ?? 0,
          error: row.o_error,
          builtGeneration: row.o_built_generation,
          attemptGeneration: row.o_attempt_generation,
          m4bBytes: row.o_m4b_bytes,
          zipBytes: row.o_zip_bytes,
        },
});

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class BookRepository {
  constructor(private readonly db: Database.Database) {}

  insert(book: NewBook, chapters: readonly NewChapter[]): void {
    const insertBook = this.db.prepare(
      `INSERT INTO books (id, title, author, language, language_source, language_confidence,
         declared_language, cover_mime, cover_path, source_path)
       VALUES (@id, @title, @author, @language, @languageSource, @languageConfidence,
         @declaredLanguage, @coverMime, @coverPath, @sourcePath)`,
    );
    const insertChapter = this.db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count, prepared_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertBook.run({
        languageSource: "unknown",
        languageConfidence: 0,
        declaredLanguage: null,
        ...book,
      });
      chapters.forEach((c, i) =>
        insertChapter.run(
          book.id,
          i + 1,
          c.title,
          c.text,
          c.text.length,
          c.wordCount,
          c.preparedChars ?? null,
        ),
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
                duration_seconds, chunk_count, chunks_done, audio_version, regen_error,
                coalesce(prepared_chars, char_count) AS prepared_chars,
                prepared_chars IS NOT NULL AS counted
         FROM chapters WHERE book_id = ? ORDER BY position`,
      )
      .all(bookId) as ChapterRow[];
    return rows.map(toChapter);
  }

  chapter(bookId: string, position: number): Chapter | undefined {
    const row = this.db
      .prepare(
        `SELECT position, title, char_count, word_count, status, progress, error, audio_path,
                duration_seconds, chunk_count, chunks_done, audio_version, regen_error,
                coalesce(prepared_chars, char_count) AS prepared_chars,
                prepared_chars IS NOT NULL AS counted
         FROM chapters WHERE book_id = ? AND position = ?`,
      )
      .get(bookId, position) as ChapterRow | undefined;
    return row && toChapter(row);
  }

  /** Counts the chapter audio writes of the book (see migration 5). */
  audioGeneration(id: string): number {
    return (this.db.prepare("SELECT audio_generation FROM books WHERE id = ?").pluck().get(id) ??
      0) as number;
  }

  /** The owner's choice of language for a book that has not started converting. */
  setLanguage(id: string, language: string): boolean {
    return this.db
      .transaction(() => {
        // The text rules differ by language, so the counts of the old one are no longer right.
        const before = this.db.prepare("SELECT language FROM books WHERE id = ?").pluck().get(id);
        const result = this.db
          .prepare(
            `UPDATE books SET language = ?, language_source = 'chosen', updated_at = ${NOW}
             WHERE id = ? AND status = 'ready'`,
          )
          .run(language, id);
        if (result.changes > 0 && before !== language) {
          this.db
            .prepare(
              "UPDATE chapters SET prepared_chars = NULL, prepared_approx = 0 WHERE book_id = ?",
            )
            .run(id);
        }
        return result.changes > 0;
      })
      .immediate();
  }

  /** Every book that is not finished with its chapters, earliest queued first (ready books last). */
  workload(): BookLoad[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.language, b.status, c.status AS chapter_status, c.progress,
                coalesce(c.prepared_chars, c.char_count) AS chars, c.prepared_chars IS NOT NULL AS counted
         FROM books b JOIN chapters c ON c.book_id = b.id
         WHERE b.status IN ('ready', 'converting', 'paused')
         ORDER BY b.queued_at IS NULL, b.queued_at, b.rowid, c.position`,
      )
      .all() as {
      id: string;
      language: string;
      status: BookStatus;
      chapter_status: ChapterStatus;
      progress: number;
      chars: number;
      counted: number;
    }[];
    const books: BookLoad[] = [];
    for (const row of rows) {
      let book = books.at(-1);
      if (book?.bookId !== row.id) {
        book = { bookId: row.id, language: row.language, status: row.status, chapters: [] };
        books.push(book);
      }
      book.chapters.push({
        status: row.chapter_status,
        progress: row.progress,
        preparedChars: row.chars,
        counted: row.counted === 1,
      });
    }
    return books;
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
            `UPDATE chapters SET status = 'queued', progress = 0, chunk_count = 0, chunks_done = 0,
               error = NULL, updated_at = ${NOW}
             WHERE book_id = ?`,
          )
          .run(id);
        return true;
      })
      .immediate();
  }
}
