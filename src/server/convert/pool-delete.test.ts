import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EncodedAudio, PcmInput } from "../audio/ffmpeg.js";
import { BookControls } from "../books/controls.js";
import { sweepStorage } from "../books/sweep.js";
import { BookTransitions } from "../books/transitions.js";
import { EncodeError } from "../audio/ffmpeg.js";
import { fakeEncode, fakeJoin } from "../testing/fake-codec.js";
import { tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { ChunkStore } from "./chunk-store.js";
import { createChapterConverter } from "./convert-chapter.js";

/** Lets a test hold an encode or a join, which then ends as cancelled when aborted, like ffmpeg. */
const hold = () => {
  let entered = false;
  return {
    get entered() {
      return entered;
    },
    async wait(tempPath: string, signal?: AbortSignal): Promise<never> {
      fs.writeFileSync(tempPath, "half written");
      entered = true;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      fs.rmSync(tempPath, { force: true });
      throw new EncodeError("Encoding was cancelled");
    },
  };
};

const leftovers = (dataDir: string) =>
  ["books", "audio"].flatMap((area) => fs.readdirSync(path.join(dataDir, area)));

describe("deleting a book with a pool running real chapter conversions", () => {
  const h = usePoolHarness();

  const setup = (options: {
    encode?: (pcm: PcmInput, out: string, signal?: AbortSignal) => Promise<EncodedAudio>;
    join?: (files: readonly string[], out: string, signal?: AbortSignal) => Promise<EncodedAudio>;
    chapters?: number;
    workers?: number;
  }) => {
    const { storage } = h.ctx;
    const id = h.addBook(options.chapters ?? 1);
    storage.ensureBookDir(id);
    storage.ensureAudioDir(id);
    fs.writeFileSync(path.join(storage.bookDir(id), "source.epub"), "epub");
    const converter = createChapterConverter({
      engine: h.ctx.engine,
      storage,
      chunks: new ChunkStore(storage),
      encode: options.encode ?? fakeEncode,
      join: options.join ?? fakeJoin,
      retryDelaysMs: [0, 0, 0],
    });
    const pool = h.start(converter, options.workers ?? 1);
    const controls = new BookControls({
      repo: h.repo,
      queue: h.queue,
      transitions: new BookTransitions(h.ctx.db, h.queue),
      storage,
      bus: h.ctx.bus,
      pool,
    });
    return { id, controls, storage };
  };
  const rowsOf = (id: string) =>
    h.ctx.db.prepare("SELECT count(*) FROM chapters WHERE book_id = ?").pluck().get(id);

  it("leaves no files, rows or events when a chunk is being encoded", async () => {
    const encoding = hold();
    const { id, controls, storage } = setup({
      encode: (_pcm, out, signal) => encoding.wait(`${out}.tmp`, signal),
    });
    await until(() => encoding.entered);

    await controls.delete(id);

    expect(leftovers(storage.dataDir)).toEqual([]);
    expect(h.repo.get(id)).toBeUndefined();
    expect(rowsOf(id)).toBe(0);
    expect(h.pool?.status().activeWorkers).toBe(0);
    const last = h.events.length;
    await tick();
    await tick();
    expect(h.events).toHaveLength(last);
    expect(h.events.at(-1)).toEqual({ type: "book-deleted", bookId: id });
  });

  it("leaves no files when the chapter is being joined", async () => {
    const joining = hold();
    const { id, controls, storage } = setup({
      join: (_files, out, signal) => joining.wait(`${out}.tmp`, signal),
    });
    await until(() => joining.entered);
    expect(fs.readdirSync(storage.audioDir(id)).length).toBeGreaterThan(0);

    await controls.delete(id);

    expect(leftovers(storage.dataDir)).toEqual([]);
    expect(rowsOf(id)).toBe(0);
  });

  it("publishes nothing about the book after book-deleted, with several workers busy", async () => {
    const encoding = hold();
    const { id, controls } = setup({
      chapters: 4,
      workers: 2,
      encode: (_pcm, out, signal) => encoding.wait(`${out}.tmp`, signal),
    });
    await until(() => h.pool?.status().activeWorkers === 2);

    await controls.delete(id);
    await tick();
    await tick();

    const deleted = h.events.findIndex((e) => e.type === "book-deleted");
    expect(deleted).toBeGreaterThan(-1);
    const after = h.events
      .slice(deleted + 1)
      .filter((e) => e.type !== "pool" && "bookId" in e && e.bookId === id);
    expect(after).toEqual([]);
    expect(h.pool?.status().activeWorkers).toBe(0);
  });

  it("does not recreate the folder when a chunk finishes after the book is gone", async () => {
    // An encoder that ignores the abort and writes later: the worker still has to settle first.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const { id, controls, storage } = setup({
      encode: async (pcm, out) => {
        entered = true;
        await gate;
        return fakeEncode(pcm, out);
      },
    });
    await until(() => entered);

    const deleting = controls.delete(id);
    await tick();
    release?.();
    await deleting;

    expect(leftovers(storage.dataDir)).toEqual([]);
  });

  it("deletes a book that is not converting, and a paused one", async () => {
    const { id, controls, storage } = setup({ chapters: 2 });
    await until(() => h.bookStatus(id) === "done");
    const ready = h.addBook(1, false);
    storage.ensureBookDir(ready);

    await controls.delete(id);
    await controls.delete(ready);

    expect(leftovers(storage.dataDir)).toEqual([]);
  });

  it("keeps other books' files and rows", async () => {
    const { id, controls, storage } = setup({ chapters: 1 });
    const other = h.addBook(1, false);
    storage.ensureBookDir(other);
    storage.ensureAudioDir(other);
    await until(() => h.bookStatus(id) === "done");

    await controls.delete(id);

    expect(leftovers(storage.dataDir).toSorted()).toEqual([other, other]);
    expect(rowsOf(other)).toBe(1);
  });

  it("reports files that could not be removed, and the startup sweep removes them", async () => {
    const { id, controls, storage } = setup({ chapters: 1 });
    await until(() => h.bookStatus(id) === "done");
    const failure = new Error("EBUSY");
    vi.spyOn(storage, "removeBookFiles").mockImplementation(() => {
      throw failure;
    });

    const { filesError } = await controls.delete(id);

    expect(filesError).toBe(failure);
    expect(h.repo.get(id)).toBeUndefined();
    expect(h.events.at(-1)).toEqual({ type: "book-deleted", bookId: id });
    expect(leftovers(storage.dataDir)).toHaveLength(2);

    const swept = sweepStorage(h.ctx.db, storage);

    expect(swept.orphanDirs).toBe(2);
    expect(leftovers(storage.dataDir)).toEqual([]);
  });

  it("answers not found for a book that is already gone", async () => {
    const { id, controls } = setup({ chapters: 1 });
    await until(() => h.bookStatus(id) === "done");
    await controls.delete(id);

    await expect(controls.delete(id)).rejects.toMatchObject({ status: 404 });
  });
});
