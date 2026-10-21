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
];
