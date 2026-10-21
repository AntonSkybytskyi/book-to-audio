import type Database from "better-sqlite3";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Applies migrations not yet recorded in `schema_migrations`, in id order.
 * Each migration runs in its own transaction. Returns the ids applied.
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[]): number[] {
  const ids = new Set<number>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`duplicate migration id ${migration.id}`);
    ids.add(migration.id);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").pluck().all() as number[]);
  const pending = migrations.filter((m) => !applied.has(m.id)).toSorted((a, b) => a.id - b.id);
  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").pluck();
  const record = db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)");
  const done: number[] = [];

  // Note: `PRAGMA foreign_keys` is a no-op inside a transaction, so a migration
  // that rebuilds a table needs foreign keys switched off around this call.
  for (const migration of pending) {
    try {
      // IMMEDIATE takes the write lock up front; re-check in case another
      // process applied this migration after `pending` was computed.
      const ran = db
        .transaction(() => {
          if (isApplied.get(migration.id)) return false;
          db.exec(migration.sql);
          record.run(migration.id, migration.name);
          return true;
        })
        .immediate();
      if (ran) done.push(migration.id);
    } catch (error) {
      throw new Error(
        `migration ${migration.id} (${migration.name}) failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  return done;
}
