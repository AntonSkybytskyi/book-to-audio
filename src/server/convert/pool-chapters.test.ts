import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { fakeEncode, fakeJoin } from "../testing/fake-codec.js";
import { until } from "../testing/pool-harness.js";
import { chunkText } from "../tts/chunk.js";
import { TtsError, type TtsSession } from "../tts/engine.js";
import { FakeEngine, type FakeEngineOptions } from "../tts/fake.js";
import { ChunkStore, type ChunkStoreOptions } from "./chunk-store.js";
import { createChapterConverter } from "./convert-chapter.js";
import { PoolStateStore } from "./pool-state.js";
import { WorkerPool } from "./pool.js";

// The pool with the real converter, chunk store and queue; only the engine and the codec are fake.

// Chunks of at most 100 characters: a short chapter still has many.
const SMALL_CHUNKS = { maxInputChars: 100 };

const sentences = (count: number, mark = "") =>
  Array.from({ length: count }, (_, i) => `This is sentence number ${i}${mark}.`).join(" ");

/** An engine whose sessions block for good after `limit` chunks in total, until aborted. */
const stallingEngine = (limit: number, options?: FakeEngineOptions) => {
  const stalling = new FakeEngine(options);
  const open = stalling.open.bind(stalling);
  let synthesized = 0;
  vi.spyOn(stalling, "open").mockImplementation(async (voiceId) => {
    const session = await open(voiceId);
    return {
      close: () => session.close(),
      synthesize: async (text, signal) => {
        if (synthesized >= limit) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
          throw new TtsError("aborted", "Synthesis was cancelled");
        }
        synthesized++;
        return session.synthesize(text, signal);
      },
    } satisfies TtsSession;
  });
  return stalling;
};

describe("WorkerPool with the real converter", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let pool: WorkerPool | undefined;
  let engine: FakeEngine;

  const addBook = (texts: string[]) => {
    const id = randomUUID();
    repo.insert(
      {
        id,
        title: "Book",
        author: null,
        language: "en",
        coverMime: null,
        coverPath: null,
        sourcePath: "s",
      },
      texts.map((text, i) => ({ title: `C${i + 1}`, text, wordCount: 5 })),
    );
    ctx.storage.ensureAudioDir(id); // as the convert route does
    repo.queue(id);
    return id;
  };

  const createPool = (
    workers: number,
    options: { engine?: FakeEngine; idleMs?: number; store?: ChunkStoreOptions } = {},
  ) => {
    engine = options.engine ?? new FakeEngine(SMALL_CHUNKS);
    ctx.settings.setWorkers(workers);
    pool = new WorkerPool({
      queue,
      engine,
      converter: createChapterConverter({
        engine,
        storage: ctx.storage,
        chunks: new ChunkStore(ctx.storage, options.store),
        encode: fakeEncode,
        join: fakeJoin,
        retryDelaysMs: [0, 0, 0],
      }),
      state: new PoolStateStore(ctx.db),
      settings: ctx.settings,
      bus: ctx.bus,
      backoffMs: 2,
      sessionIdleMs: options.idleMs,
      progressIntervalMs: 0,
    });
    pool.start();
    return pool;
  };

  const audio = (bookId: string, position: number) =>
    fs.readFileSync(
      ctx.storage.resolve(`audio/${bookId}/${String(position).padStart(2, "0")}.webm`),
    );
  const chunkFiles = (bookId: string, position: number) => {
    try {
      return fs
        .readdirSync(ctx.storage.partsDir(bookId, position))
        .filter((n) => n.endsWith(".webm"));
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool?.stop();
    pool = undefined;
    ctx.cleanup();
  });

  it("resumes from the saved chunk after a stop and a start, with the same audio as an uninterrupted run", async () => {
    const text = sentences(25);
    const total = chunkText(text, 100).length;
    expect(total).toBeGreaterThanOrEqual(6);
    const control = addBook([text]);
    createPool(1);
    await until(() => repo.get(control)?.status === "done");
    await pool?.stop();
    const expected = audio(control, 1);

    const id = addBook([text]);
    createPool(1, { engine: stallingEngine(3, SMALL_CHUNKS) });
    await until(() => repo.chapter(id, 1)?.chunksDone === 3);
    await pool?.stop();

    // Stopped mid-chapter: queued again, three chunks on disk and in the database.
    expect(repo.chapter(id, 1)).toMatchObject({
      status: "queued",
      chunkCount: total,
      chunksDone: 3,
    });
    expect(chunkFiles(id, 1)).toHaveLength(3);

    const resumed = new FakeEngine(SMALL_CHUNKS);
    const open = vi.spyOn(resumed, "open");
    createPool(1, { engine: resumed });
    await until(() => repo.get(id)?.status === "done");

    expect(repo.chapter(id, 1)).toMatchObject({
      chunkCount: total,
      chunksDone: total,
      progress: 1,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(audio(id, 1).equals(expected)).toBe(true);
    // The chunks are deleted once the chapter is finished.
    expect(fs.existsSync(ctx.storage.partsDir(id, 1))).toBe(false);
  });

  it("synthesizes only the missing chunks on resume", async () => {
    const text = sentences(25);
    const total = chunkText(text, 100).length;
    const id = addBook([text]);
    createPool(1, { engine: stallingEngine(2, SMALL_CHUNKS) });
    await until(() => repo.chapter(id, 1)?.chunksDone === 2);
    await pool?.stop();
    let calls = 0;
    const counting = new FakeEngine(SMALL_CHUNKS);
    const open = counting.open.bind(counting);
    vi.spyOn(counting, "open").mockImplementation(async (voice) => {
      const session = await open(voice);
      return {
        close: () => session.close(),
        synthesize: (t, signal) => {
          calls++;
          return session.synthesize(t, signal);
        },
      };
    });

    createPool(1, { engine: counting });
    await until(() => repo.get(id)?.status === "done");

    expect(calls).toBe(total - 2);
  });

  it("starts the chapter over when the voice changed between the stop and the resume", async () => {
    const text = sentences(25);
    const total = chunkText(text, 100).length;
    const id = addBook([text]);
    createPool(1, { engine: stallingEngine(3, SMALL_CHUNKS) });
    await until(() => repo.chapter(id, 1)?.chunksDone === 3);
    await pool?.stop();
    expect(chunkFiles(id, 1)).toHaveLength(3);

    // Another voice for the same language, at another sample rate: the three old chunks do not fit.
    const other = new FakeEngine({
      ...SMALL_CHUNKS,
      voices: [{ id: "fake-en-2", language: "en", name: "Other", sampleRate: 16_000 }],
    });
    const synthesized: string[] = [];
    const open = other.open.bind(other);
    vi.spyOn(other, "open").mockImplementation(async (voice) => {
      const session = await open(voice);
      return {
        close: () => session.close(),
        synthesize: (t, signal) => {
          synthesized.push(t);
          return session.synthesize(t, signal);
        },
      };
    });
    createPool(1, { engine: other });
    await until(() => repo.get(id)?.status === "done");

    expect(synthesized).toHaveLength(total); // every chunk again, none reused
    expect(repo.chapter(id, 1)).toMatchObject({ chunkCount: total, chunksDone: total });
  });

  it("keeps the chunks when only the engine process was replaced, not the voice", async () => {
    const text = sentences(25);
    const id = addBook([text]);
    createPool(1, { engine: stallingEngine(3, SMALL_CHUNKS) });
    await until(() => repo.chapter(id, 1)?.chunksDone === 3);
    await pool?.stop();

    const again = new FakeEngine(SMALL_CHUNKS);
    createPool(1, { engine: again });
    await until(() => repo.chapter(id, 1)?.chunksDone === 4);

    expect(chunkFiles(id, 1).length).toBeGreaterThanOrEqual(4);
  });

  it("gives each worker its own engine session and reuses it across chapters", async () => {
    const id = addBook(Array.from({ length: 6 }, () => sentences(10)));
    createPool(2);

    await until(() => repo.get(id)?.status === "done");

    expect(engine.opened).toBeLessThanOrEqual(2);
    expect(engine.openSessions).toBeGreaterThanOrEqual(1);
    await pool?.stop();
    expect(engine.openSessions).toBe(0);
  });

  it("closes the session of a worker that stops when the count goes down, and keeps the other", async () => {
    const id = addBook(Array.from({ length: 4 }, () => sentences(10)));
    const p = createPool(2);
    await until(() => repo.get(id)?.status === "done");
    expect(engine.openSessions).toBe(2);

    p.setWorkers(1);

    await until(() => engine.openSessions === 1);
    await p.stop();
    expect(engine.openSessions).toBe(0);
  });

  it("closes a session that has been idle, and opens another when work arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = addBook([sentences(10)]);
    const p = createPool(1, { idleMs: 60_000 });
    await until(() => repo.get(first)?.status === "done");
    expect(engine.openSessions).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(engine.openSessions).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.openSessions).toBe(0);

    const second = addBook([sentences(10)]);
    p.notify();
    await until(() => repo.get(second)?.status === "done");
    expect(engine.opened).toBe(2);
  });

  it("retries a flaky chunk, fails a broken one after four attempts and ends done with errors", async () => {
    const flakyEngine = new FakeEngine({ flakyMarker: "[flaky]", failMarker: "[broken]" });
    // The broken marker is in the last chunk of chapter 2, so the first chunks are finished before it fails.
    const id = addBook([
      sentences(5, " [flaky]"),
      `${sentences(30)} A [broken] end.`,
      sentences(5),
    ]);
    createPool(1, { engine: flakyEngine });

    await until(() => repo.get(id)?.status === "done_with_errors");

    expect(repo.chapters(id).map((c) => c.status)).toEqual(["done", "failed", "done"]);
    expect(repo.chapter(id, 2)?.error).toBe(
      "The speech engine failed on this chapter. Tried 4 times.",
    );
    // What was finished before the bad chunk is kept, so the chapter can continue from it later.
    expect(repo.chapter(id, 2)?.chunksDone).toBeGreaterThan(0);
    expect(chunkFiles(id, 2)).toHaveLength(repo.chapter(id, 2)?.chunksDone ?? -1);
  });

  it("pauses the pool after three failed chapters and continues after resume", async () => {
    const broken = new FakeEngine({ failMarker: "[broken]" });
    const id = addBook([
      ...Array.from({ length: 3 }, () => sentences(3, " [broken]")),
      sentences(3),
      sentences(3),
    ]);
    const p = createPool(1, { engine: broken });

    await until(() => p.status().state === "paused");

    expect(p.status()).toMatchObject({
      cause: "failures",
      error: "The speech engine failed on this chapter. Tried 4 times.",
    });
    expect(repo.chapters(id).map((c) => c.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "queued",
      "queued",
    ]);
    p.resume();
    await until(() => repo.get(id)?.status === "done_with_errors");
    expect(
      repo
        .chapters(id)
        .map((c) => c.status)
        .slice(3),
    ).toEqual(["done", "done"]);
  });

  it("does not count unreadable text towards pausing the pool", async () => {
    const picky = new FakeEngine({ badMarker: "[bad]" });
    const id = addBook(Array.from({ length: 5 }, () => sentences(3, " [bad]")));
    const p = createPool(1, { engine: picky });

    await until(() => repo.get(id)?.status === "done_with_errors");

    expect(repo.chapters(id).map((c) => c.status)).toEqual(Array(5).fill("failed"));
    expect(p.status().state).toBe("running");
  });

  describe("when the disk is nearly full", () => {
    it("stops before writing, keeps what was finished, and carries on after resume", async () => {
      // The disk has room for the first three chunks; every check after that finds it nearly full.
      let checks = 0;
      const freeBytes = async () => (++checks > 3 ? 100 * 1024 ** 2 : 10 * 1024 ** 3);
      const text = sentences(25);
      const total = chunkText(text, 100).length;
      const id = addBook([text]);
      const p = createPool(1, {
        store: { minFreeBytes: 500 * 1024 ** 2, freeBytes },
      });
      await until(() => p.status().state === "paused");

      expect(p.status()).toMatchObject({ cause: "disk", error: expect.stringContaining("disk") });
      const kept = repo.chapter(id, 1);
      expect(kept).toMatchObject({ status: "queued", error: null });
      expect(chunkFiles(id, 1)).toHaveLength(kept?.chunksDone ?? -1);
      expect(kept?.chunksDone).toBe(3);
      expect(kept?.chunksDone).toBeLessThan(total);

      checks = -Infinity; // there is room again
      p.resume();
      await until(() => repo.get(id)?.status === "done");
      expect(repo.chapter(id, 1)).toMatchObject({ chunksDone: total, status: "done" });
    });
  });

  it("does not make the folder of a book that was deleted while it was converting", async () => {
    const text = sentences(25);
    const id = addBook([text]);
    createPool(1, { engine: stallingEngine(2, SMALL_CHUNKS) });
    await until(() => repo.chapter(id, 1)?.chunksDone === 2);
    await pool?.stop();

    // Slice 3's delete removes the rows and the files.
    ctx.storage.removeBookFiles(id);
    createPool(1);
    await until(() => repo.chapter(id, 1)?.status === "failed");

    expect(fs.existsSync(ctx.storage.audioDir(id))).toBe(false);
  });
});
