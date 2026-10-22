import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { migrations } from "./migrations.js";

describe("migrations 3 and 4 (chapter pool)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  it("upgrades a database that already holds converted books, keeping their chapters", () => {
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 2),
    );
    db.prepare(
      "INSERT INTO books (id, title, source_path, status) VALUES ('b', 'T', 's', 'done')",
    ).run();
    db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count, status, progress)
       VALUES ('b', 1, 'C', 'text', 4, 1, 'done', 1)`,
    ).run();

    expect(runMigrations(db, migrations)).toEqual([3, 4, 5, 6, 7]);

    expect(
      db.prepare("SELECT status, progress, chunk_count, chunks_done, claim FROM chapters").get(),
    ).toEqual({
      status: "done",
      progress: 1,
      chunk_count: 0,
      chunks_done: 0,
      claim: 0,
    });
  });

  it("starts the pool running with no failures and no saved settings", () => {
    runMigrations(db, migrations);

    expect(db.prepare("SELECT state, error, consecutive_failures FROM pool_state").all()).toEqual([
      { state: "running", error: null, consecutive_failures: 0 },
    ]);
    expect(db.prepare("SELECT count(*) FROM settings").pluck().get()).toBe(0);
  });

  it("records why the pool paused, and only as one of the known causes", () => {
    runMigrations(db, migrations);

    db.prepare("UPDATE pool_state SET state = 'paused', cause = 'disk'").run();
    expect(db.prepare("SELECT cause FROM pool_state").pluck().get()).toBe("disk");
    expect(() => db.prepare("UPDATE pool_state SET cause = 'boredom'").run()).toThrow(/CHECK/);
  });

  it("keeps the pool state to one row with a known state", () => {
    runMigrations(db, migrations);

    expect(() => db.prepare("INSERT INTO pool_state (id) VALUES (2)").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE pool_state SET state = 'stuck'").run()).toThrow(/CHECK/);
  });
});

describe("migration 5 (book controls)", () => {
  it("adds the audio version, the regeneration error and the audio generation, keeping existing rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 4),
    );
    db.prepare(
      "INSERT INTO books (id, title, source_path, status) VALUES ('b', 'T', 's', 'done')",
    ).run();
    db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count, status, audio_path)
       VALUES ('b', 1, 'C', 'text', 4, 1, 'done', 'audio/b/01.webm')`,
    ).run();

    expect(runMigrations(db, migrations)).toEqual([5, 6, 7]);

    expect(db.prepare("SELECT audio_version, regen_error, audio_path FROM chapters").get()).toEqual(
      { audio_version: 0, regen_error: null, audio_path: "audio/b/01.webm" },
    );
    expect(db.prepare("SELECT audio_generation FROM books").pluck().get()).toBe(0);
    db.close();
  });
});

describe("migration 6 (book outputs)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, migrations);
    db.prepare("INSERT INTO books (id, title, source_path) VALUES ('b', 'T', 's')").run();
  });

  afterEach(() => {
    db.close();
  });

  it("holds one row per book, in a known state, and goes away with the book", () => {
    db.prepare("INSERT INTO book_outputs (book_id, state) VALUES ('b', 'queued')").run();

    expect(() =>
      db.prepare("INSERT INTO book_outputs (book_id, state) VALUES ('b', 'ready')").run(),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE book_outputs SET state = 'none'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE book_outputs SET progress = 2").run()).toThrow(/CHECK/);

    db.prepare("DELETE FROM books WHERE id = 'b'").run();
    expect(db.prepare("SELECT count(*) FROM book_outputs").pluck().get()).toBe(0);
  });

  it("does not take a row for a book that does not exist", () => {
    expect(() =>
      db.prepare("INSERT INTO book_outputs (book_id, state) VALUES ('nope', 'queued')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("migration 7 (book language detection)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 6),
    );
    db.prepare(
      "INSERT INTO books (id, title, source_path, language) VALUES ('old', 'T', 's', 'uk')",
    ).run();
    runMigrations(db, migrations);
  });

  afterEach(() => {
    db.close();
  });

  it("keeps existing books, whose language the owner or the metadata set, as chosen", () => {
    expect(
      db
        .prepare(
          "SELECT language, language_source, language_confidence, declared_language FROM books",
        )
        .get(),
    ).toEqual({
      language: "uk",
      language_source: "chosen",
      language_confidence: 0,
      declared_language: null,
    });
    // A book added afterwards without a verdict is unknown until detection says otherwise.
    db.prepare("INSERT INTO books (id, title, source_path) VALUES ('new', 'T', 's')").run();
    expect(db.prepare("SELECT language_source FROM books WHERE id = 'new'").pluck().get()).toBe(
      "unknown",
    );
  });

  it("allows only known origins and a confidence from 0 to 1", () => {
    expect(() => db.prepare("UPDATE books SET language_source = 'guessed'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE books SET language_confidence = 1.5").run()).toThrow(/CHECK/);
    db.prepare("UPDATE books SET language_source = 'detected', language_confidence = 0.9").run();
  });
});
