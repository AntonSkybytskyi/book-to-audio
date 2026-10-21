import { describe, expect, it } from "vitest";
import { TtsError } from "./engine.js";
import { FakeEngine } from "./fake.js";

describe("FakeEngine", () => {
  const engine = new FakeEngine();

  it("describes itself as a local engine with an English voice", () => {
    expect(engine).toMatchObject({ id: "fake", kind: "local" });
    expect(engine.voices()).toEqual([{ id: "fake-en", language: "en", name: "Fake English" }]);
  });

  it("returns mono 16-bit PCM whose length scales with the text", async () => {
    const short = await engine.synthesize({ text: "x".repeat(30), voiceId: "fake-en", speed: 1 });
    const long = await engine.synthesize({ text: "x".repeat(300), voiceId: "fake-en", speed: 1 });

    expect(short.channels).toBe(1);
    expect(short.samples.length % 2).toBe(0);
    expect(long.samples.length).toBeGreaterThan(short.samples.length * 5);
    expect(short.samples.length / 2 / short.sampleRate).toBeCloseTo(2, 1);
  });

  it("is deterministic", async () => {
    const request = { text: "Same text", voiceId: "fake-en", speed: 1 };

    expect(
      (await engine.synthesize(request)).samples.equals((await engine.synthesize(request)).samples),
    ).toBe(true);
  });

  it("is faster at higher speed", async () => {
    const normal = await engine.synthesize({ text: "x".repeat(100), voiceId: "fake-en", speed: 1 });
    const fast = await engine.synthesize({ text: "x".repeat(100), voiceId: "fake-en", speed: 2 });

    expect(fast.samples.length).toBeLessThan(normal.samples.length);
  });

  it("rejects unknown voices and oversized text", async () => {
    await expect(
      engine.synthesize({ text: "hi", voiceId: "nope", speed: 1 }),
    ).rejects.toMatchObject({
      code: "voice_not_found",
    });
    await expect(
      engine.synthesize({
        text: "x".repeat(engine.maxInputChars + 1),
        voiceId: "fake-en",
        speed: 1,
      }),
    ).rejects.toBeInstanceOf(TtsError);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const pending = new FakeEngine({ delayMs: 5000 }).synthesize({
      text: "hello",
      voiceId: "fake-en",
      speed: 1,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
