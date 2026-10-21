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
    const list = touch("audio", id, ".3f2a.list");

    const result = sweepStorage(ctx.db, ctx.storage);

    expect(result).toEqual({ orphanDirs: 0, tempFiles: 2, partsDirs: 0 });
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(done)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.existsSync(list)).toBe(false);
  });

  it("keeps the chunks of chapters that may continue and removes the rest", () => {
    const repo = new BookRepository(ctx.db);
    const id = randomUUID();
    repo.insert(
      {
        id,
        title: "T",
        author: null,
        language: "en",
        coverMime: null,
        coverPath: null,
        sourcePath: "s",
      },
      ["1", "2", "3", "4"].map((text) => ({ title: text, text, wordCount: 1 })),
    );
    repo.queue(id);
    ctx.db
      .prepare("UPDATE chapters SET status = ? WHERE book_id = ? AND position = ?")
      .run("generating", id, 2);
    ctx.db
      .prepare("UPDATE chapters SET status = ? WHERE book_id = ? AND position = ?")
      .run("done", id, 3);
    ctx.db
      .prepare("UPDATE chapters SET status = ? WHERE book_id = ? AND position = ?")
      .run("failed", id, 4);
    const queued = touch("audio", id, "01.parts", "00000.pcm");
    const generating = touch("audio", id, "02.parts", "00000.pcm");
    const done = touch("audio", id, "03.parts", "00000.pcm");
    const failed = touch("audio", id, "04.parts", "00000.pcm");
    const noChapter = touch("audio", id, "09.parts", "00000.pcm");

    const result = sweepStorage(ctx.db, ctx.storage);

    expect(result.partsDirs).toBe(2);
    expect(fs.existsSync(queued)).toBe(true);
    expect(fs.existsSync(generating)).toBe(true);
    expect(fs.existsSync(failed)).toBe(true); // a failed chapter may be run again from its chunks
    expect(fs.existsSync(done)).toBe(false);
    expect(fs.existsSync(noChapter)).toBe(false);
  });

  it("leaves anything that is not named like a book id", () => {
    const stray = touch("books", "not-a-uuid", "keep.txt");
    const loose = touch("audio", "notes.txt");

    expect(sweepStorage(ctx.db, ctx.storage)).toEqual({
      orphanDirs: 0,
      tempFiles: 0,
      partsDirs: 0,
    });
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.existsSync(loose)).toBe(true);
  });

  it("does nothing on an empty data directory", () => {
    expect(sweepStorage(ctx.db, ctx.storage)).toEqual({
      orphanDirs: 0,
      tempFiles: 0,
      partsDirs: 0,
    });
  });
});
