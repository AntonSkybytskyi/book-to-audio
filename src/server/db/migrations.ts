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
];
