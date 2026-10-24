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

    expect(runMigrations(db, migrations)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);

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

    expect(runMigrations(db, migrations)).toEqual([5, 6, 7, 8, 9, 10, 11]);

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

describe("migration 8 (speed benchmark)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 7),
    );
    db.prepare("INSERT INTO books (id, title, source_path) VALUES ('old', 'T', 's')").run();
    db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count)
       VALUES ('old', 1, 'C', 'text', 4, 1)`,
    ).run();
    runMigrations(db, migrations);
  });

  afterEach(() => {
    db.close();
  });

  it("leaves the prepared count of an existing chapter empty, to be counted later", () => {
    expect(db.prepare("SELECT prepared_chars FROM chapters").pluck().get()).toBeNull();
    db.prepare("UPDATE chapters SET prepared_chars = 12").run();
    expect(db.prepare("SELECT prepared_chars FROM chapters").pluck().get()).toBe(12);
  });

  const result = (voice: string, rate: number) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO benchmark_results (engine, voice_id, language, seconds_per_kchar, rtf,
           encode_factor, model_load_ms, throughput, sample_chars, sample_audio_seconds, cpu_count,
           cpu_model, text_version, measured_at)
         VALUES ('piper', ?, 'en', ?, 0.2, NULL, 900, '[]', 1500, 100, 8, 'cpu', 3, 'now')`,
      )
      .run(voice, rate);

  it("keeps one benchmark row per engine and voice, the newest", () => {
    result("a", 60);
    result("a", 65);
    result("b", 70);
    expect(
      db.prepare("SELECT voice_id, seconds_per_kchar FROM benchmark_results ORDER BY 1").all(),
    ).toEqual([
      { voice_id: "a", seconds_per_kchar: 65 },
      { voice_id: "b", seconds_per_kchar: 70 },
    ]);
  });

  it("keeps what was learned per engine and voice", () => {
    const learn = db.prepare(
      "INSERT INTO speed_learning (engine, voice_id, seconds_per_kchar, slowdown, samples) VALUES ('piper', 'a', 60, 1.1, 2)",
    );
    learn.run();
    expect(() => learn.run()).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("migration 9 (benchmark load)", () => {
  it("keeps results from before it, with no load recorded and one attempt", () => {
    const db = new Database(":memory:");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 8),
    );
    db.prepare(
      `INSERT INTO benchmark_results (engine, voice_id, language, seconds_per_kchar, rtf, encode_factor,
         model_load_ms, throughput, sample_chars, sample_audio_seconds, cpu_count, cpu_model, text_version, measured_at)
       VALUES ('piper', 'v', 'en', 60, 0.1, NULL, 1, '[]', 1, 1, 8, 'cpu', 3, 'x')`,
    ).run();

    expect(
      runMigrations(
        db,
        migrations.filter((m) => m.id <= 10),
      ),
    ).toEqual([9, 10]);

    expect(
      db
        .prepare("SELECT load_start, load_end, load_attempt, run_seconds FROM benchmark_results")
        .get(),
    ).toEqual({ load_start: null, load_end: null, load_attempt: 1, run_seconds: null });
    db.close();
  });
});

describe("migration 10 (approximate counts)", () => {
  it("starts every chapter with an exact count (or none yet)", () => {
    const db = new Database(":memory:");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 9),
    );
    db.prepare("INSERT INTO books (id, title, source_path) VALUES ('b', 'T', 's')").run();
    db.prepare(
      `INSERT INTO chapters (book_id, position, title, text, char_count, word_count, prepared_chars)
       VALUES ('b', 1, 'C', 'text', 4, 1, 4)`,
    ).run();

    expect(runMigrations(db, migrations)).toEqual([10, 11]);

    expect(db.prepare("SELECT prepared_chars, prepared_approx FROM chapters").get()).toEqual({
      prepared_chars: 4,
      prepared_approx: 0,
    });
    db.close();
  });
});

describe("migration 11 (TTS services)", () => {
  it("forgets speeds measured under the old voice ids and the global worker count, and adds the service pause", () => {
    const db = new Database(":memory:");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 10),
    );
    db.prepare(
      `INSERT INTO benchmark_results (engine, voice_id, language, seconds_per_kchar, rtf, encode_factor,
         model_load_ms, throughput, sample_chars, sample_audio_seconds, cpu_count, cpu_model, text_version, measured_at)
       VALUES ('piper', 'v', 'en', 60, 0.1, NULL, 1, '[]', 1, 1, 8, 'cpu', 3, 'x')`,
    ).run();
    db.prepare(
      "INSERT INTO speed_learning (engine, voice_id, seconds_per_kchar, slowdown, samples) VALUES ('piper', 'v', 60, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('workers', '3'), ('shown_languages', '[\"en\"]')",
    ).run();
    db.prepare(
      "UPDATE pool_state SET state = 'paused', error = 'Broken.', cause = 'failures'",
    ).run();

    expect(runMigrations(db, migrations)).toEqual([11]);

    expect(db.prepare("SELECT COUNT(*) FROM benchmark_results").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM speed_learning").pluck().get()).toBe(0);
    expect(db.prepare("SELECT key FROM settings").pluck().all()).toEqual(["shown_languages"]);
    expect(db.prepare("SELECT state, error, cause FROM pool_state").get()).toEqual({
      state: "running",
      error: null,
      cause: null,
    });
    db.prepare("INSERT INTO service_state (service) VALUES ('piper')").run();
    expect(
      db.prepare("SELECT state, error, consecutive_failures FROM service_state").get(),
    ).toEqual({
      state: "running",
      error: null,
      consecutive_failures: 0,
    });
    expect(() =>
      db.prepare("INSERT INTO service_state (service, state) VALUES ('x', 'stopped')").run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("keeps a pause for a full disk", () => {
    const db = new Database(":memory:");
    runMigrations(
      db,
      migrations.filter((m) => m.id <= 10),
    );
    db.prepare(
      "UPDATE pool_state SET state = 'paused', error = 'The disk is full.', cause = 'disk'",
    ).run();

    expect(runMigrations(db, migrations)).toEqual([11]);

    expect(db.prepare("SELECT state, error, cause FROM pool_state").get()).toEqual({
      state: "paused",
      error: "The disk is full.",
      cause: "disk",
    });
    db.close();
  });
});
