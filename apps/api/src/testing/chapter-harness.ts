import fs from "node:fs";
import { afterEach, beforeEach, vi } from "vitest";
import type { ClaimedChapter } from "../books/queue.js";
import { ChunkStore } from "../convert/chunk-store.js";
import {
  createChapterConverter,
  type ChapterConverterDeps,
  type ChapterRun,
} from "../convert/convert-chapter.js";
import { SessionHolder } from "../convert/sessions.js";
import { chunkText } from "../tts/chunk.js";
import type { FakeEngine } from "../tts/fake.js";
import { createTestContext, type TestContext } from "./context.js";
import { fakeEncode, fakeJoin } from "./fake-codec.js";

export const BOOK = "6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11";
export const TEXT = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i}.`).join(" ");

export const task = (overrides: Partial<ClaimedChapter> = {}): ClaimedChapter => ({
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

/** The texts the engine was asked to read, in order. */
export const spokenBy = (engine: FakeEngine) => {
  const spoken: string[] = [];
  const open = engine.open.bind(engine);
  vi.spyOn(engine, "open").mockImplementation(async (voiceId) => {
    const session = await open(voiceId);
    return {
      close: () => session.close(),
      synthesize: (text, signal) => {
        spoken.push(text);
        return session.synthesize(text, signal);
      },
    };
  });
  return spoken;
};

/**
 * What the chapter converter tests share: a test context with a chunk store, a converter wired to
 * the fake codec, and helpers to run a chapter. Call it inside a `describe`; it registers its own
 * `beforeEach` and `afterEach`.
 */
export function useChapterHarness() {
  const holders: SessionHolder[] = [];
  const retryDelays: number[] = [];
  const warnings: { context: object; message: string }[] = [];
  const encode = vi.fn<typeof fakeEncode>(fakeEncode);
  const join = vi.fn<typeof fakeJoin>(fakeJoin);
  let ctx!: TestContext;
  let store!: ChunkStore;

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

  const converter = (
    engine: FakeEngine = ctx.engine,
    chunks: ChunkStore = store,
    extra: Partial<ChapterConverterDeps> = {},
  ) =>
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
      ...extra,
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

  return {
    get ctx() {
      return ctx;
    },
    get store() {
      return store;
    },
    encode,
    join,
    retryDelays,
    warnings,
    converter,
    run,
    partsOf,
    chunkFiles: () => fs.readdirSync(partsOf()).filter((n) => n.endsWith(".webm")),
    chunkCount: (maxChars = ctx.engine.maxInputChars) => chunkText(TEXT, maxChars).length,
  };
}
