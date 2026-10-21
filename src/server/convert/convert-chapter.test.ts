import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedChapter } from "../books/queue.js";
import { DiskFullError } from "../errors.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { fakeEncode, fakeJoin } from "../testing/fake-codec.js";
import { chunkText } from "../tts/chunk.js";
import { TtsError } from "../tts/engine.js";
import { FakeEngine, type FakeEngineOptions } from "../tts/fake.js";
import { ChunkStore, type ChunkStoreOptions } from "./chunk-store.js";
import { createChapterConverter, type ChapterRun } from "./convert-chapter.js";
import { SessionHolder } from "./sessions.js";

const BOOK = "6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11";

const TEXT = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i}.`).join(" ");

const task = (overrides: Partial<ClaimedChapter> = {}): ClaimedChapter => ({
  id: 1,
  bookId: BOOK,
  position: 2,
  title: "Two",
  text: TEXT,
  language: "en",
  claim: 1,
  chunkCount: 0,
  chunksDone: 0,
  ...overrides,
});

describe("createChapterConverter", () => {
  let ctx: TestContext;
  let store: ChunkStore;
  const holders: SessionHolder[] = [];
  const retryDelays: number[] = [];
  const warnings: { context: object; message: string }[] = [];
  const encode = vi.fn<typeof fakeEncode>(fakeEncode);
  const join = vi.fn<typeof fakeJoin>(fakeJoin);

  beforeEach(() => {
    ctx = createTestContext();
    ctx.storage.ensureAudioDir(BOOK); // as the convert route does
    store = new ChunkStore(ctx.storage);
    retryDelays.length = 0;
    warnings.length = 0;
    encode.mockClear();
    join.mockClear();
  });

  afterEach(async () => {
    await Promise.all(holders.splice(0).map((holder) => holder.close()));
    ctx.cleanup();
  });

  const converter = (engine: FakeEngine = ctx.engine, chunks: ChunkStore = store) =>
    createChapterConverter({
      engine,
      storage: ctx.storage,
      chunks,
      encode,
      join,
      logger: { warn: (context, message) => warnings.push({ context, message }) },
      retryDelaysMs: [1000, 5000, 15_000],
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

  const run = (
    engine: FakeEngine,
    overrides: Partial<ChapterRun> = {},
  ): ChapterRun & { saved: [number, number][] } => {
    const sessions = new SessionHolder(engine);
    holders.push(sessions);
    const saved: [number, number][] = [];
    return {
      task: task(),
      sessions,
      signal: new AbortController().signal,
      saveProgress: (done, total) => {
        saved.push([done, total]);
        return true;
      },
      ...overrides,
      saved,
    };
  };

  const partsOf = (position = 2) => ctx.storage.partsDir(BOOK, position);
  const chunkFiles = () => fs.readdirSync(partsOf()).filter((n) => n.endsWith(".webm"));
  const chunkCount = (maxChars = ctx.engine.maxInputChars) => chunkText(TEXT, maxChars).length;

  it("encodes every chunk as it is made, reports progress after each, and joins them into one file", async () => {
    const total = chunkCount();
    const job = run(ctx.engine);

    const result = await converter().convert(job);

    expect(total).toBeGreaterThan(1);
    expect(job.saved).toEqual([
      [0, total],
      ...Array.from({ length: total }, (_, i): [number, number] => [i + 1, total]),
    ]);
    expect(encode).toHaveBeenCalledTimes(total);
    expect(chunkFiles()).toHaveLength(total);
    expect(result.audioPath).toBe(`audio/${BOOK}/02.webm`);
    expect(fs.existsSync(ctx.storage.resolve(result.audioPath))).toBe(true);
    expect(result.durationSeconds).toBeGreaterThan(10);
  });

  it("joins exactly the chunk files, in order, and never holds the chapter in memory", async () => {
    const total = chunkCount();

    await converter().convert(run(ctx.engine));

    expect(join).toHaveBeenCalledOnce();
    const [files, output] = join.mock.calls[0] ?? [];
    expect(files?.map((f) => path.basename(f))).toEqual(
      Array.from({ length: total }, (_, i) => `${String(i).padStart(5, "0")}.webm`),
    );
    expect(output).toBe(ctx.storage.resolve(`audio/${BOOK}/02.webm`));
    // Each encoder call got one chunk's samples, not the chapter's.
    const biggest = Math.max(
      ...encode.mock.calls.map(([pcm]) => (Buffer.isBuffer(pcm.samples) ? pcm.samples.length : 0)),
    );
    const chapterBytes = fs.statSync(ctx.storage.resolve(`audio/${BOOK}/02.webm`)).size;
    expect(biggest).toBeLessThan(chapterBytes / 2);
  });

  it("gives the join the summed chunk lengths, for when ffmpeg cannot measure the result", async () => {
    await converter().convert(run(ctx.engine));

    const [, , , fallback] = join.mock.calls[0] ?? [];
    const summed = encode.mock.results.length;
    expect(summed).toBeGreaterThan(1);
    expect(fallback).toBeGreaterThan(10);
  });

  it("splits a chapter the same way every time", () => {
    expect(chunkText(TEXT, 400)).toEqual(chunkText(TEXT, 400));
  });

  it("resumes from the first chunk that is not on disk, with the same result", async () => {
    const total = chunkCount();
    const first = await converter().convert(run(ctx.engine));
    const whole = fs.readFileSync(ctx.storage.resolve(first.audioPath));
    // Pretend a restart after chunk 3: later chunks and the output are gone.
    for (let i = 3; i < total; i++) fs.rmSync(store.chunkPath(BOOK, 2, i));
    fs.rmSync(ctx.storage.resolve(first.audioPath));
    const fresh = new FakeEngine();
    const spy = vi.spyOn(fresh, "open");
    const job = run(fresh, { task: task({ chunkCount: total, chunksDone: 3 }) });

    const second = await converter(fresh).convert(job);

    expect(job.saved[0]).toEqual([3, total]); // starts from what is on disk
    expect(job.saved).toHaveLength(1 + (total - 3));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.durationSeconds).toBeCloseTo(first.durationSeconds, 5);
    expect(fs.readFileSync(ctx.storage.resolve(second.audioPath)).equals(whole)).toBe(true);
  });

  it("trusts the files over the saved counter", async () => {
    const total = chunkCount();
    store.open(BOOK, 2, {
      engine: "fake",
      voice: "fake-en",
      sampleRate: 22_050,
      chunkCount: total,
    });
    for (const index of [0, 1])
      fs.writeFileSync(store.chunkPath(BOOK, 2, index), Buffer.alloc(100));
    // The counter says 1: the process died after the second chunk and before the update.
    const job = run(ctx.engine, { task: task({ chunkCount: total, chunksDone: 1 }) });

    await converter().convert(job);

    expect(job.saved[0]).toEqual([2, total]);
  });

  it("starts over when the chapter now splits into a different number of chunks", async () => {
    const total = chunkCount();
    store.open(BOOK, 2, {
      engine: "fake",
      voice: "fake-en",
      sampleRate: 22_050,
      chunkCount: total + 5,
    });
    fs.writeFileSync(store.chunkPath(BOOK, 2, 0), "stale audio of another split");
    const job = run(ctx.engine, { task: task({ chunkCount: total + 5, chunksDone: 1 }) });

    const result = await converter().convert(job);

    expect(job.saved[0]).toEqual([0, total]);
    expect(
      fs.readFileSync(ctx.storage.resolve(result.audioPath)).includes(Buffer.from("stale audio")),
    ).toBe(false);
  });

  it("starts over when the voice or sample rate is not the one that made the chunks", async () => {
    const total = chunkCount();
    store.open(BOOK, 2, {
      engine: "fake",
      voice: "old-voice",
      sampleRate: 16_000,
      chunkCount: total,
    });
    fs.writeFileSync(store.chunkPath(BOOK, 2, 0), "audio of the old voice");
    const job = run(ctx.engine, { task: task({ chunkCount: total, chunksDone: 1 }) });

    const result = await converter().convert(job);

    expect(job.saved[0]).toEqual([0, total]);
    expect(
      fs.readFileSync(ctx.storage.resolve(result.audioPath)).includes(Buffer.from("old voice")),
    ).toBe(false);
  });

  describe("text with nothing to read", () => {
    const withSymbols = "First sentence here.\n\n* * *\n\nLast sentence here.";
    const options: FakeEngineOptions = { maxInputChars: 20 };

    it("is not sent to the engine and becomes a short pause", async () => {
      const engine = new FakeEngine(options);
      const texts: string[] = [];
      const open = engine.open.bind(engine);
      vi.spyOn(engine, "open").mockImplementation(async (voice) => {
        const session = await open(voice);
        return {
          close: () => session.close(),
          synthesize: (text, signal) => {
            texts.push(text);
            return session.synthesize(text, signal);
          },
        };
      });
      const job = run(engine, { task: task({ text: withSymbols }) });

      const result = await converter(engine).convert(job);

      expect(chunkText(withSymbols, 20)).toEqual([
        "First sentence here.",
        "* * *",
        "Last sentence here.",
      ]);
      expect(texts).toEqual(["First sentence here.", "Last sentence here."]);
      expect(chunkFiles()).toHaveLength(3);
      const pause = fs.statSync(store.chunkPath(BOOK, 2, 1)).size / 2 / 22_050;
      expect(pause).toBeCloseTo(0.3, 2);
      expect(result.durationSeconds).toBeGreaterThan(0.3);
    });

    it("counts letters and digits in any script as something to read", async () => {
      const engine = new FakeEngine({ maxInputChars: 10 });
      const synthesize = vi.fn<(text: string) => void>();
      const open = engine.open.bind(engine);
      vi.spyOn(engine, "open").mockImplementation(async (voice) => {
        const session = await open(voice);
        return {
          close: () => session.close(),
          synthesize: (text, signal) => {
            synthesize(text);
            return session.synthesize(text, signal);
          },
        };
      });

      await converter(engine).convert(
        run(engine, { task: task({ text: "1984.\n\nПривіт.\n\n— … —" }) }),
      );

      expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["1984.", "Привіт."]);
    });
  });

  it("retries a chunk on a fresh session and carries on", async () => {
    const engine = new FakeEngine({ flakyMarker: "number 7." });
    const job = run(engine);

    await converter(engine).convert(job);

    expect(retryDelays).toEqual([1000, 5000]);
    expect(warnings.map((w) => w.message)).toEqual([
      "chunk failed, retrying in 1 s",
      "chunk failed, retrying in 5 s",
    ]);
    expect(warnings[0]?.context).toMatchObject({ bookId: BOOK, chapter: 2, attempt: 1 });
    expect(engine.opened).toBe(3); // the failing session is replaced each time
    expect(engine.openSessions).toBe(1);
  });

  it("gives up after four attempts and says so, keeping the chunks before the bad one", async () => {
    const engine = new FakeEngine({ failMarker: "number 45." });
    const job = run(engine);

    const error = await converter(engine)
      .convert(job)
      .catch((e: unknown) => e);

    expect(retryDelays).toEqual([1000, 5000, 15_000]);
    expect(error).toMatchObject({
      code: "synthesis_failed",
      message: "The speech engine failed on this chapter. Tried 4 times.",
      detail: expect.stringContaining("fail marker"),
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.at(-1)?.message).toBe("chunk failed");
    expect(join).not.toHaveBeenCalled();
    expect(job.saved.at(-1)?.[0]).toBeGreaterThan(0);
    expect(chunkFiles()).toHaveLength(job.saved.at(-1)?.[0] ?? -1);
  });

  it("does not retry text that cannot be read", async () => {
    const engine = new FakeEngine({ badMarker: "number 7." });

    await expect(converter(engine).convert(run(engine))).rejects.toMatchObject({
      code: "bad_input",
    });

    expect(retryDelays).toEqual([]);
  });

  it("does not retry when the engine or voice is missing", async () => {
    const engine = new FakeEngine();
    vi.spyOn(engine, "open").mockRejectedValue(new TtsError("engine_unavailable", "not installed"));

    await expect(converter(engine).convert(run(engine))).rejects.toMatchObject({
      code: "engine_unavailable",
      message: "not installed",
    });
    expect(retryDelays).toEqual([]);
  });

  it("fails when the engine has no voice for the language", async () => {
    await expect(
      converter().convert(run(ctx.engine, { task: task({ language: "uk" }) })),
    ).rejects.toMatchObject({ code: "voice_not_found", message: expect.stringContaining("uk") });
  });

  it("fails a chapter without text instead of encoding silence", async () => {
    await expect(
      converter().convert(run(ctx.engine, { task: task({ text: "  \n\n " }) })),
    ).rejects.toMatchObject({ code: "bad_input", message: expect.stringContaining("no text") });
  });

  it("stops between chunks once aborted", async () => {
    const controller = new AbortController();
    const engine = new FakeEngine();
    const job = run(engine, {
      signal: controller.signal,
      saveProgress: (done) => {
        if (done === 2) controller.abort();
        return true;
      },
    });

    await expect(converter(engine).convert(job)).rejects.toMatchObject({ code: "aborted" });

    expect(chunkFiles()).toHaveLength(2);
    expect(join).not.toHaveBeenCalled();
  });

  it("stops waiting to retry when aborted", async () => {
    const controller = new AbortController();
    const engine = new FakeEngine({ failMarker: "number 7." });
    const fast = createChapterConverter({
      engine,
      storage: ctx.storage,
      chunks: store,
      encode,
      join,
      sleep: async () => controller.abort(),
    });

    await expect(fast.convert(run(engine, { signal: controller.signal }))).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("stops when the claim is stale", async () => {
    const engine = new FakeEngine();
    const synthesized = vi.fn<() => void>();
    const originalOpen = engine.open.bind(engine);
    vi.spyOn(engine, "open").mockImplementation(async (voice) => {
      const session = await originalOpen(voice);
      return {
        synthesize: (text, signal) => {
          synthesized();
          return session.synthesize(text, signal);
        },
        close: () => session.close(),
      };
    });
    let calls = 0;
    const job = run(engine, { saveProgress: () => ++calls < 3 });

    await expect(converter(engine).convert(job)).rejects.toMatchObject({ code: "aborted" });

    expect(synthesized).toHaveBeenCalledTimes(2);
  });

  const withSpace = (freeBytes: ChunkStoreOptions["freeBytes"]) =>
    new ChunkStore(ctx.storage, { minFreeBytes: 500 * 1024 ** 2, freeBytes });

  describe("disk space", () => {
    it("is checked before every chunk, so the first one is not written to a full disk", async () => {
      const checks = vi.fn<() => Promise<number>>(async () => 100 * 1024 ** 2);

      await expect(
        converter(ctx.engine, withSpace(checks)).convert(run(ctx.engine)),
      ).rejects.toBeInstanceOf(DiskFullError);

      expect(checks).toHaveBeenCalledOnce();
      expect(encode).not.toHaveBeenCalled();
    });

    it("stops in the middle of a chapter when the disk fills up, keeping what is done", async () => {
      let calls = 0;
      const job = run(ctx.engine);

      await expect(
        converter(
          ctx.engine,
          withSpace(async () => (++calls > 3 ? 1024 ** 2 : 1024 ** 4)),
        ).convert(job),
      ).rejects.toBeInstanceOf(DiskFullError);

      expect(chunkFiles()).toHaveLength(3);
      expect(job.saved.at(-1)?.[0]).toBe(3);
    });
  });

  it("does not make the folder of a book that was deleted", async () => {
    ctx.storage.removeBookFiles(BOOK);

    await expect(converter().convert(run(ctx.engine))).rejects.toMatchObject({ code: "ENOENT" });

    expect(fs.existsSync(ctx.storage.audioDir(BOOK))).toBe(false);
  });

  it("removes the chunks and an unrecorded output on request", async () => {
    const result = await converter().convert(run(ctx.engine));

    converter().discardChunks(task());
    converter().discardAudio(result.audioPath);

    expect(fs.existsSync(ctx.storage.partsDir(BOOK, 2))).toBe(false);
    expect(fs.existsSync(ctx.storage.resolve(result.audioPath))).toBe(false);
  });
});
