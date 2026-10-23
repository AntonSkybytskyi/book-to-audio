import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedChapter } from "../books/queue.js";
import { spokenBy, task, useChapterHarness } from "../testing/chapter-harness.js";
import type { TestContext } from "../testing/context.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import { TtsError } from "../tts/engine.js";
import { FakeEngine } from "../tts/fake.js";
import type { TextPreparer } from "./chapter-text.js";
import type { ChunkStore } from "./chunk-store.js";

describe("the text of a chapter and the speaker", () => {
  const harness = useChapterHarness();
  const { converter, run, partsOf, encode, join } = harness;
  let ctx: TestContext;
  let store: ChunkStore;

  beforeEach(() => {
    ctx = harness.ctx;
    store = harness.store;
  });

  // metaOf
  const metaOf = () =>
    JSON.parse(fs.readFileSync(path.join(partsOf(), "meta.json"), "utf8")) as Record<
      string,
      unknown
    >;

  const UK_VOICE = "uk_UA-ukrainian_tts-medium:lada";
  const ukEngine = (voiceId = UK_VOICE, speaker = "lada") =>
    new FakeEngine({
      maxInputChars: 400,
      voices: [
        { id: voiceId, language: "uk", name: voiceId, sampleRate: 22_050, speaker },
        { id: "fake-en", language: "en", name: "Fake English", sampleRate: 22_050 },
      ],
    });
  const UK_TEXT = "У 1999 році було 21 книга і 15%. Далі XIX століття, і т. д.";
  const ukTask = (overrides: Partial<ClaimedChapter> = {}) =>
    task({ text: UK_TEXT, language: "uk", ...overrides });
  it("reads the text as prepared for the language, not as it is in the book", async () => {
    const engine = ukEngine();
    const spoken = spokenBy(engine);

    await converter(engine).convert(run(engine, { task: ukTask() }));

    expect(spoken.join(" ")).toBe(
      "У тисяча дев'ятсот дев'яносто дев'ятому році було двадцять одна книга і п'ятнадцять відсотків. Далі дев'ятнадцяте століття, і так далі.",
    );
  });

  it("records the voice, the speaker and the version of the text rules next to the chunks", async () => {
    const engine = ukEngine();
    // The chunks are removed once the chapter is done: stop it after the first one.
    const stopped = new AbortController();
    const job = run(engine, {
      task: ukTask(),
      signal: stopped.signal,
      saveProgress: () => {
        stopped.abort();
        return true;
      },
    });
    await expect(converter(engine).convert(job)).rejects.toMatchObject({ code: "aborted" });

    expect(metaOf()).toEqual({
      format: 1,
      engine: "fake",
      voice: UK_VOICE,
      speaker: "lada",
      sampleRate: 22_050,
      chunkCount: expect.any(Number),
      textVersion: TEXT_PROCESSING_VERSION,
    });
  });

  it("keeps the chunks of an interrupted chapter when nothing changed", async () => {
    const engine = ukEngine();
    const text = Array.from({ length: 30 }, (_, i) => `Це речення номер ${i}.`).join(" ");
    let stop = new AbortController();
    const interrupted = run(engine, {
      task: ukTask({ text }),
      signal: stop.signal,
      saveProgress: (done) => {
        if (done === 2) stop.abort();
        return true;
      },
    });
    await expect(converter(engine).convert(interrupted)).rejects.toMatchObject({
      code: "aborted",
    });
    stop = new AbortController();
    const resumed = run(engine, { task: ukTask({ text }) });

    await converter(engine).convert(resumed);

    expect(resumed.saved[0]?.[0]).toBe(2);
  });

  const interrupt = async (engine: FakeEngine, text: string) => {
    const stop = new AbortController();
    const job = run(engine, {
      task: ukTask({ text }),
      signal: stop.signal,
      saveProgress: (done) => {
        if (done === 2) stop.abort();
        return true;
      },
    });
    await expect(converter(engine).convert(job)).rejects.toMatchObject({ code: "aborted" });
  };
  const LONG = Array.from({ length: 30 }, (_, i) => `Це речення номер ${i}.`).join(" ");

  it("starts over when the speaker is another one", async () => {
    await interrupt(ukEngine(), LONG);
    const other = ukEngine("uk_UA-ukrainian_tts-medium:tetiana", "tetiana");
    const job = run(other, { task: ukTask({ text: LONG }) });

    await converter(other).convert(job);

    expect(job.saved[0]?.[0]).toBe(0);
  });

  it("starts over when the speaker changed under the same voice id", async () => {
    await interrupt(ukEngine(), LONG);
    const other = ukEngine(UK_VOICE, "tetiana");
    const job = run(other, { task: ukTask({ text: LONG }) });

    await converter(other).convert(job);

    expect(job.saved[0]?.[0]).toBe(0);
  });

  it("starts over when the text rules have a new version", async () => {
    const engine = ukEngine();
    await interrupt(engine, LONG);
    vi.resetModules();
    vi.doMock("../text/index.js", async (original) => ({
      ...(await original<typeof import("../text/index.js")>()),
      TEXT_PROCESSING_VERSION: TEXT_PROCESSING_VERSION + 1,
    }));
    const { createChapterConverter: newer } = await import("./convert-chapter.js");
    const job = run(engine, { task: ukTask({ text: LONG }) });

    await newer({
      engine,
      storage: ctx.storage,
      chunks: store,
      encode,
      join,
      retryDelaysMs: [],
    }).convert(job);

    expect(job.saved[0]?.[0]).toBe(0);
    vi.doUnmock("../text/index.js");
    vi.resetModules();
  });

  it("leaves English text that needs no rule exactly as it is", async () => {
    const spoken = spokenBy(ctx.engine);

    await converter().convert(run(ctx.engine, { task: task({ text: "One two. Three four." }) }));

    expect(spoken).toEqual(["One two. Three four."]);
  });

  it("hands the text, the language, the engine's limit and the signal to the text preparer", async () => {
    const engine = ukEngine();
    const prepareText = vi.fn<TextPreparer>(async () => ["Один."]);
    const job = run(engine, { task: ukTask() });

    await converter(engine, store, { prepareText }).convert(job);

    expect(prepareText).toHaveBeenCalledExactlyOnceWith(
      UK_TEXT,
      "uk",
      engine.maxInputChars,
      job.signal,
    );
  });

  it("fails a chapter whose text cannot be prepared as bad_input, before anything is made", async () => {
    const engine = ukEngine();
    const unreadable = new TtsError("bad_input", "The text of this chapter could not be prepared.");
    const spoken = spokenBy(engine);
    const job = run(engine, { task: ukTask() });

    const error = await converter(engine, store, {
      prepareText: async () => {
        throw unreadable;
      },
    })
      .convert(job)
      .catch((e: unknown) => e);

    expect(error).toBe(unreadable);
    expect(spoken).toEqual([]);
    expect(job.saved).toEqual([]);
    expect(fs.existsSync(partsOf())).toBe(false);
  });

  it("stops when the conversion is cancelled while the text is being prepared", async () => {
    const engine = ukEngine();
    const stop = new AbortController();
    const job = run(engine, { task: ukTask(), signal: stop.signal });

    const outcome = converter(engine, store, {
      prepareText: async () => {
        stop.abort();
        return ["Один."];
      },
    })
      .convert(job)
      .catch((e: unknown) => e);

    expect(await outcome).toMatchObject({ code: "aborted" });
    expect(fs.existsSync(partsOf())).toBe(false);
  });
});
