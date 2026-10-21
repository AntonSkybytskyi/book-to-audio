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

    expect(runMigrations(db, migrations)).toEqual([3, 4]);

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
