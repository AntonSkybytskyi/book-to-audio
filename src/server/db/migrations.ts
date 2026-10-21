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
];
