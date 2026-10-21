import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { BookRepository } from "./repository.js";
import { sweepStorage } from "./sweep.js";

describe("sweepStorage", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => ctx.cleanup());

  const touch = (...parts: string[]) => {
    const file = path.join(ctx.dataDir, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    return file;
  };

  const addBook = () => {
    const id = randomUUID();
    new BookRepository(ctx.db).insert(
      {
        id,
        title: "T",
        author: null,
        language: "en",
        coverMime: null,
        coverPath: null,
        sourcePath: "s",
      },
      [{ title: "C", text: "t", wordCount: 1 }],
    );
    return id;
  };

  it("removes folders of books that are not in the database", () => {
    const orphan = randomUUID();
    touch("books", orphan, "source.epub");
    touch("audio", orphan, "01.webm");

    const result = sweepStorage(ctx.db, ctx.storage);

    expect(result.orphanDirs).toBe(2);
    expect(fs.existsSync(path.join(ctx.dataDir, "books", orphan))).toBe(false);
    expect(fs.existsSync(path.join(ctx.dataDir, "audio", orphan))).toBe(false);
  });

  it("keeps the files of known books but removes unfinished temp audio", () => {
    const id = addBook();
    const source = touch("books", id, "source.epub");
    const done = touch("audio", id, "01.webm");
    const temp = touch("audio", id, ".3f2a.tmp");

    const result = sweepStorage(ctx.db, ctx.storage);

    expect(result).toEqual({ orphanDirs: 0, tempFiles: 1 });
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(done)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
  });

  it("leaves anything that is not named like a book id", () => {
    const stray = touch("books", "not-a-uuid", "keep.txt");
    const loose = touch("audio", "notes.txt");

    expect(sweepStorage(ctx.db, ctx.storage)).toEqual({ orphanDirs: 0, tempFiles: 0 });
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.existsSync(loose)).toBe(true);
  });

  it("does nothing on an empty data directory", () => {
    expect(sweepStorage(ctx.db, ctx.storage)).toEqual({ orphanDirs: 0, tempFiles: 0 });
  });
});
