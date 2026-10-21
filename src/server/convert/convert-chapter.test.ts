import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EncodedAudio } from "../audio/ffmpeg.js";
import type { ClaimedChapter } from "../books/queue.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import type { PcmAudio } from "../tts/engine.js";
import { createChapterConverter } from "./convert-chapter.js";

const BOOK = "6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11";

const task = (overrides: Partial<ClaimedChapter> = {}): ClaimedChapter => ({
  id: 1,
  bookId: BOOK,
  position: 2,
  title: "Two",
  text: Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}.`).join(" "),
  language: "en",
  ...overrides,
});

describe("createChapterConverter", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => ctx.cleanup());

  const encodeToFile = vi.fn<(pcm: PcmAudio, outputPath: string) => Promise<EncodedAudio>>(
    async (pcm, outputPath) => {
      fs.writeFileSync(outputPath, pcm.samples);
      return { durationSeconds: pcm.samples.length / 2 / pcm.sampleRate };
    },
  );

  const converter = () =>
    createChapterConverter({ engine: ctx.engine, storage: ctx.storage, encode: encodeToFile });

  it("synthesizes every chunk, reports progress and encodes one file", async () => {
    const progress: number[] = [];

    const result = await converter()(task(), (p) => progress.push(p), new AbortController().signal);

    expect(result.audioPath).toBe(`audio/${BOOK}/02.webm`);
    expect(fs.existsSync(ctx.storage.resolve(result.audioPath))).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
    expect(progress.at(-1)).toBeLessThan(1); // 1 is reserved for the finished file
    expect(result.durationSeconds).toBeGreaterThan(10);
  });

  it("fails when the engine has no voice for the language", async () => {
    await expect(
      converter()(task({ language: "uk" }), () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "voice_not_found", message: expect.stringContaining("uk") });
  });

  it("stops between chunks once aborted", async () => {
    const controller = new AbortController();
    const synthesize = vi.spyOn(ctx.engine, "synthesize");

    const pending = converter()(task(), () => controller.abort(), controller.signal);

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("propagates engine failures", async () => {
    vi.spyOn(ctx.engine, "synthesize").mockRejectedValue(new Error("engine down"));

    await expect(converter()(task(), () => {}, new AbortController().signal)).rejects.toThrow(
      "engine down",
    );
  });
});
