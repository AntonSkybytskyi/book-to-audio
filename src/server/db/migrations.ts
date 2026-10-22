import type { Migration } from "./migrate.js";

// Append new migrations with the next id. Never edit one that has shipped.
export const migrations: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) STRICT;
    `,
  },
  {
    id: 2,
    name: "books_and_chapters",
    sql: `
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        language TEXT NOT NULL DEFAULT 'en',
        -- paused is used from slice 3
        status TEXT NOT NULL DEFAULT 'ready'
          CHECK (status IN ('ready', 'converting', 'paused', 'done', 'done_with_errors')),
        cover_mime TEXT,
        -- Paths are relative to the data directory and built from the book id.
        cover_path TEXT,
        source_path TEXT NOT NULL,
        -- Set when Convert is clicked; the queue is FIFO on this.
        queued_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE chapters (
        id INTEGER PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
        -- 1-based
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        -- pending: the book has not been converted yet; Convert moves it to queued
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'queued', 'generating', 'done', 'failed')),
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        error TEXT,
        audio_path TEXT,
        duration_seconds REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (book_id, position)
      ) STRICT;

      CREATE INDEX chapters_status ON chapters (status);
      CREATE INDEX books_queue ON books (status, queued_at);
    `,
  },
  {
    id: 3,
    name: "chapter_pool",
    sql: `
      -- Progress is saved per chunk: chunk_count is fixed when the chapter starts,
      -- chunks_done is how many have been written to disk.
      ALTER TABLE chapters ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chapters ADD COLUMN chunks_done INTEGER NOT NULL DEFAULT 0;
      -- Bumped each time a worker claims the chapter. Updates from a worker only
      -- apply while the claim it holds is the current one.
      ALTER TABLE chapters ADD COLUMN claim INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      -- One row. 'paused' is set by the circuit breaker and cleared by Resume.
      CREATE TABLE pool_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'paused')),
        error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      INSERT INTO pool_state (id) VALUES (1);
    `,
  },
  {
    id: 4,
    name: "pool_pause_cause",
    sql: `
      -- Why the pool is paused, so the app can say what to fix: chapters kept failing, or the disk is full.
      ALTER TABLE pool_state ADD COLUMN cause TEXT CHECK (cause IN ('failures', 'disk'));
    `,
  },
  {
    id: 5,
    name: "book_controls",
    sql: `
      -- Bumped each time a chapter's audio file is written. The player puts it in the audio URL,
      -- so a regenerated chapter is never played from a cached copy of the old file.
      ALTER TABLE chapters ADD COLUMN audio_version INTEGER NOT NULL DEFAULT 0;
      -- Why the last regeneration of a finished chapter failed. The chapter stays done with its
      -- previous audio; cleared when it is regenerated again.
      ALTER TABLE chapters ADD COLUMN regen_error TEXT;
      -- Bumped whenever any chapter's audio of the book is written. Whoever builds the M4B and ZIP
      -- reads it when a build starts and records the generation it built from; the outputs are
      -- current while the two are equal. A write during a build leaves them different. It counts
      -- the writes that were recorded: a worker whose claim went stale while joining can still
      -- rename its file over a chapter's file (rare), and that is not counted, so a build must not
      -- assume the generation covers every write to the files.
      ALTER TABLE books ADD COLUMN audio_generation INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 6,
    name: "book_outputs",
    sql: `
      -- The M4B and ZIP of a book, one row per book once a build was ever wanted (no row: never).
      -- The files are outputs/<book id>/book.m4b and book.zip; this row says what state they are in.
      CREATE TABLE book_outputs (
        book_id TEXT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
        -- queued and building are re-queued at startup; failed keeps its message in error.
        state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'ready', 'failed')),
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        error TEXT,
        -- books.audio_generation the files on disk were built from (null: no files). The files
        -- are current only while it equals the book's generation, state is ready and the book is done.
        built_generation INTEGER,
        -- The generation the latest build started from. A failed build is only tried again by itself
        -- once the audio has changed since; until then the owner retries it.
        attempt_generation INTEGER,
        m4b_bytes INTEGER,
        zip_bytes INTEGER,
        queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE INDEX book_outputs_state ON book_outputs (state, queued_at);
    `,
  },
  {
    id: 7,
    name: "book_language_detection",
    sql: `
      -- Where books.language came from: the text of the book (detected), its dc:language
      -- (metadata), nothing (unknown: English is only a placeholder) or the owner (chosen).
      ALTER TABLE books ADD COLUMN language_source TEXT NOT NULL DEFAULT 'unknown'
        CHECK (language_source IN ('detected', 'metadata', 'unknown', 'chosen'));
      -- 0 to 1: how sure the text detection was; 0 when it did not decide.
      ALTER TABLE books ADD COLUMN language_confidence REAL NOT NULL DEFAULT 0
        CHECK (language_confidence >= 0 AND language_confidence <= 1);
      -- The supported language the book's dc:language names, if any.
      ALTER TABLE books ADD COLUMN declared_language TEXT;
      -- Books from before this migration had their language set by the owner or from dc:language,
      -- never by the text: they are 'chosen', so no preview asks to check them again.
      UPDATE books SET language_source = 'chosen';
    `,
  },
  {
    id: 8,
    name: "speed_benchmark",
    sql: `
      -- Prepared characters of a chapter: what the speech engine is given after the text rules,
      -- so a time estimate does not run the rules again. Null until counted (books from before this
      -- migration are counted in the background at startup); a count that failed is the raw length.
      ALTER TABLE chapters ADD COLUMN prepared_chars INTEGER;

      -- The latest benchmark of each voice: one row per engine and voice, replaced by the next run.
      CREATE TABLE benchmark_results (
        engine TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        language TEXT NOT NULL,
        -- Seconds of audio per 1,000 characters of prepared text.
        seconds_per_kchar REAL NOT NULL,
        -- Seconds of synthesis per second of audio, one session, model load excluded.
        rtf REAL NOT NULL,
        -- Seconds of Opus encoding per second of audio; null when nothing was encoded.
        encode_factor REAL,
        model_load_ms INTEGER NOT NULL,
        -- JSON array of {workers, audioPerSecond}: audio per second of waiting with that many sessions.
        throughput TEXT NOT NULL,
        sample_chars INTEGER NOT NULL,
        sample_audio_seconds REAL NOT NULL,
        cpu_count INTEGER NOT NULL,
        cpu_model TEXT NOT NULL,
        -- TEXT_PROCESSING_VERSION: the speech rate is per character of text the rules produce.
        text_version INTEGER NOT NULL,
        measured_at TEXT NOT NULL,
        PRIMARY KEY (engine, voice_id)
      ) STRICT;

      -- What real conversions taught the app about a voice: a running average of the speech rate and of
      -- how much slower than the benchmark chapters were read. Cleared when the voice is benchmarked again.
      CREATE TABLE speed_learning (
        engine TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        seconds_per_kchar REAL NOT NULL,
        slowdown REAL NOT NULL,
        samples INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (engine, voice_id)
      ) STRICT;
    `,
  },
  {
    id: 9,
    name: "benchmark_load",
    sql: `
      -- The 1-minute load average when a benchmark run began and ended. The one at the start says how
      -- busy the computer was with other programs; the one at the end includes the benchmark itself.
      ALTER TABLE benchmark_results ADD COLUMN load_start REAL;
      ALTER TABLE benchmark_results ADD COLUMN load_end REAL;
      -- How many times in a row the voice was measured while the computer was busy; a busy run is
      -- repeated once at the next start, not again and again.
      ALTER TABLE benchmark_results ADD COLUMN load_attempt INTEGER NOT NULL DEFAULT 1;
      -- How long the run took, so the pages can say how long a speed test is expected to last.
      ALTER TABLE benchmark_results ADD COLUMN run_seconds REAL;
    `,
  },
  {
    id: 10,
    name: "prepared_chars_approx",
    sql: `
      -- 1 when prepared_chars is only the raw length, because the text rules gave up on the chapter (or
      -- ran out of time): good enough for an estimate, counted again later.
      ALTER TABLE chapters ADD COLUMN prepared_approx INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
