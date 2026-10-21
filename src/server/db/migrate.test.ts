import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Migration, runMigrations } from "./migrate.js";

const tables = (db: Database.Database) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  const migrations: Migration[] = [
    {
      id: 2,
      name: "add_b",
      sql: "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))",
    },
    { id: 1, name: "add_a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
  ];

  it("applies pending migrations in id order and records them", () => {
    expect(runMigrations(db, migrations)).toEqual([1, 2]);

    expect(tables(db)).toEqual(["a", "b", "schema_migrations"]);
    expect(db.prepare("SELECT id, name FROM schema_migrations ORDER BY id").all()).toEqual([
      { id: 1, name: "add_a" },
      { id: 2, name: "add_b" },
    ]);
  });

  it("does nothing when every migration is already applied", () => {
    runMigrations(db, migrations);

    expect(runMigrations(db, migrations)).toEqual([]);
  });

  it("applies only migrations added since the last run", () => {
    runMigrations(db, migrations.slice(1));

    expect(runMigrations(db, migrations)).toEqual([2]);
  });

  it("skips a migration another connection applied in the meantime", () => {
    // Migration 1 also records migration 2, as a concurrent process would after
    // this run listed the pending ids.
    const racing: Migration[] = [
      {
        id: 1,
        name: "add_a",
        sql: `CREATE TABLE a (id INTEGER PRIMARY KEY);
              CREATE TABLE b (id INTEGER PRIMARY KEY);
              INSERT INTO schema_migrations (id, name) VALUES (2, 'add_b');`,
      },
      migrations[0]!,
    ];

    expect(runMigrations(db, racing)).toEqual([1]);
  });

  it("rolls back a failing migration and keeps earlier ones", () => {
    const broken: Migration[] = [
      migrations[1]!,
      { id: 2, name: "broken", sql: "CREATE TABLE c (id INTEGER); NOT VALID SQL" },
    ];

    expect(() => runMigrations(db, broken)).toThrow(/migration 2 \(broken\)/);
    expect(tables(db)).toEqual(["a", "schema_migrations"]);
    expect(db.prepare("SELECT id FROM schema_migrations").pluck().all()).toEqual([1]);
  });

  it("rejects duplicate migration ids", () => {
    expect(() => runMigrations(db, [migrations[1]!, { ...migrations[1]!, name: "again" }])).toThrow(
      /duplicate migration id 1/,
    );
  });
});
