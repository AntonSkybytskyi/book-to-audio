import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";

describe("openDatabase", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "book-to-audio-")), "data");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  });

  it("creates the data directory layout and the database file", () => {
    const db = openDatabase(dataDir);
    db.close();

    expect(fs.existsSync(path.join(dataDir, "books"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "audio"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "app.db"))).toBe(true);
  });

  it("applies migrations and enables foreign keys and WAL", () => {
    const db = openDatabase(dataDir);

    expect(db.prepare("SELECT count(*) FROM schema_migrations").pluck().get()).toBeGreaterThan(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("keeps data across reopening", () => {
    const first = openDatabase(dataDir);
    first.prepare("INSERT INTO app_meta (key, value) VALUES ('probe', 'kept')").run();
    first.close();

    const second = openDatabase(dataDir);
    expect(second.prepare("SELECT value FROM app_meta WHERE key = 'probe'").pluck().get()).toBe(
      "kept",
    );
    second.close();
  });
});
