import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { ChunkStore, type ChunkMeta } from "./chunk-store.js";

const BOOK = "6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11";
const META: ChunkMeta = {
  engine: "piper",
  voice: "en_US-lessac-medium",
  sampleRate: 22_050,
  chunkCount: 5,
};

describe("ChunkStore", () => {
  let ctx: TestContext;
  let store: ChunkStore;
  const dir = () => ctx.storage.partsDir(BOOK, 2);
  /** What the encoder does: a chunk file appears whole. */
  const finish = (index: number, content = "audio") =>
    fs.writeFileSync(store.chunkPath(BOOK, 2, index), content);

  beforeEach(() => {
    ctx = createTestContext();
    ctx.storage.ensureAudioDir(BOOK);
    store = new ChunkStore(ctx.storage);
  });

  afterEach(() => ctx.cleanup());

  it("keeps chunks in audio/<book>/<NN>.parts, and says what they were made with", () => {
    expect(store.open(BOOK, 2, META)).toBe(0);

    expect(path.relative(ctx.dataDir, dir())).toBe(path.join("audio", BOOK, "02.parts"));
    expect(JSON.parse(fs.readFileSync(path.join(dir(), "meta.json"), "utf8"))).toEqual({
      format: 1,
      ...META,
    });
    expect(path.basename(store.chunkPath(BOOK, 2, 7))).toBe("00007.webm");
  });

  it("counts the chunks from the start up to the first gap, never past the chapter's end", () => {
    store.open(BOOK, 2, META);
    for (const index of [0, 1, 3]) finish(index);

    expect(store.open(BOOK, 2, META)).toBe(2);
    expect(store.open(BOOK, 2, { ...META, chunkCount: 2 })).toBe(0); // another split: starts over
    for (const index of [0, 1]) finish(index);
    expect(store.open(BOOK, 2, { ...META, chunkCount: 2 })).toBe(2);
  });

  it.each([
    ["engine", { engine: "fake" }],
    ["voice", { voice: "en_US-ryan-high" }],
    ["sample rate", { sampleRate: 16_000 }],
    ["number of chunks", { chunkCount: 6 }],
  ])("throws the chunks away when the %s differs", (_name, change) => {
    store.open(BOOK, 2, META);
    finish(0);
    finish(1);

    expect(store.open(BOOK, 2, { ...META, ...change })).toBe(0);

    expect(fs.readdirSync(dir())).toEqual(["meta.json"]);
    expect(store.open(BOOK, 2, { ...META, ...change })).toBe(0);
  });

  it("does not trust chunks that have no record of what made them", () => {
    fs.mkdirSync(dir());
    finish(0);

    expect(store.open(BOOK, 2, META)).toBe(0);
    expect(fs.existsSync(store.chunkPath(BOOK, 2, 0))).toBe(false);
  });

  it("treats an empty chunk file as missing and removes it", () => {
    store.open(BOOK, 2, META);
    finish(0);
    finish(1, "");
    finish(2);

    expect(store.open(BOOK, 2, META)).toBe(1);
    expect(fs.existsSync(store.chunkPath(BOOK, 2, 1))).toBe(false);
  });

  it("remembers chunk lengths, and says so when any is missing", () => {
    store.open(BOOK, 2, META);
    store.saveDuration(BOOK, 2, 0, 10.5);
    store.saveDuration(BOOK, 2, 1, 20);

    expect(store.totalSeconds(BOOK, 2, 2)).toBe(30.5);
    expect(store.totalSeconds(BOOK, 2, 3)).toBeNull();
    expect(store.open(BOOK, 2, { ...META, chunkCount: 2 })).toBe(0); // lengths do not count as chunks
  });

  it("ignores and clears a half-written temp file", () => {
    store.open(BOOK, 2, META);
    finish(0);
    fs.writeFileSync(path.join(dir(), ".abc.tmp"), "partial");

    expect(store.open(BOOK, 2, META)).toBe(1);
    expect(fs.readdirSync(dir()).toSorted()).toEqual(["00000.webm", "meta.json"]);
  });

  it("does not make the folder of a book that is gone", () => {
    ctx.storage.removeBookFiles(BOOK);

    expect(() => store.open(BOOK, 2, META)).toThrow(/ENOENT/);
    expect(fs.existsSync(ctx.storage.audioDir(BOOK))).toBe(false);
  });

  it("lists the chunk files in order for joining", () => {
    expect(store.chunkPaths(BOOK, 2, 3).map((p) => path.basename(p))).toEqual([
      "00000.webm",
      "00001.webm",
      "00002.webm",
    ]);
  });

  it("removes the folder, and removing twice is fine", () => {
    store.open(BOOK, 2, META);

    store.remove(BOOK, 2);
    store.remove(BOOK, 2);

    expect(fs.existsSync(dir())).toBe(false);
  });

  const withFree = (free: number | Error, minFreeBytes = 500 * 1024 ** 2) =>
    new ChunkStore(ctx.storage, {
      minFreeBytes,
      freeBytes: async () => {
        if (free instanceof Error) throw free;
        return free;
      },
    });

  describe("free space", () => {
    it("passes when there is more than the margin", async () => {
      await expect(withFree(501 * 1024 ** 2).ensureSpace()).resolves.toBeUndefined();
    });

    it("throws a user-facing error when there is less than the margin", async () => {
      const error = await withFree(499 * 1024 ** 2)
        .ensureSpace()
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        name: "DiskFullError",
        message: "The disk is almost full. Free some space, then resume.",
        detail: expect.stringContaining("499 MB free"),
      });
    });

    it("measures the data directory's disk", async () => {
      const seen: string[] = [];
      const real = new ChunkStore(ctx.storage, {
        freeBytes: async (disk) => {
          seen.push(disk);
          return 1024 ** 4;
        },
      });

      await real.ensureSpace();

      expect(seen).toEqual([ctx.dataDir]);
    });

    it("asks the real file system by default", async () => {
      await expect(
        new ChunkStore(ctx.storage, { minFreeBytes: 1 }).ensureSpace(),
      ).resolves.toBeUndefined();
    });

    it("does not call a file system full when it cannot say how much is free", async () => {
      await expect(
        withFree(new Error("statfs not supported")).ensureSpace(),
      ).resolves.toBeUndefined();
    });
  });
});
