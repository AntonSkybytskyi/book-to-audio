import { describe, expect, it } from "vitest";
import { TtsError, type TtsSession } from "./engine.js";
import { FakeEngine, type FakeEngineOptions } from "./fake.js";

const openSession = (options?: FakeEngineOptions) => {
  const engine = new FakeEngine(options);
  return { engine, session: engine.open("fake-en") };
};

const attempt = async (session: TtsSession, text: string) => {
  try {
    await session.synthesize(text);
    return "ok";
  } catch (error) {
    return error instanceof TtsError ? error.code : "other";
  }
};

describe("FakeEngine", () => {
  it("describes itself as a ready engine with an English voice", () => {
    const engine = new FakeEngine();
    expect(engine).toMatchObject({ id: "fake", concurrency: 4, ready: true, reachable: true });
    expect(engine.voices()).toEqual([
      { id: "fake-en", language: "en", name: "Fake English", sampleRate: 22_050 },
    ]);
  });

  it("returns mono 16-bit PCM whose length scales with the text", async () => {
    const session = await openSession().session;
    const short = await session.synthesize("x".repeat(30));
    const long = await session.synthesize("x".repeat(300));

    expect(short.channels).toBe(1);
    expect(short.samples.length % 2).toBe(0);
    expect(long.samples.length).toBeGreaterThan(short.samples.length * 5);
    expect(short.samples.length / 2 / short.sampleRate).toBeCloseTo(2, 1);
  });

  it("is deterministic", async () => {
    const session = await openSession().session;
    const first = await session.synthesize("Same text");
    const second = await session.synthesize("Same text");

    expect(first.samples.equals(second.samples)).toBe(true);
  });

  it("rejects unknown voices and oversized text", async () => {
    const { engine, session } = openSession();

    await expect(engine.open("nope")).rejects.toMatchObject({ code: "voice_not_found" });
    await expect(
      (await session).synthesize("x".repeat(engine.maxInputChars + 1)),
    ).rejects.toBeInstanceOf(TtsError);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const session = await openSession({ delayMs: 5000 }).session;
    const pending = session.synthesize("hello", controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("counts the sessions that are open", async () => {
    const engine = new FakeEngine();
    const a = await engine.open("fake-en");
    const b = await engine.open("fake-en");
    expect(engine.openSessions).toBe(2);

    await a.close();
    await a.close(); // closing twice counts once
    expect(engine.openSessions).toBe(1);
    await b.close();

    expect(engine.openSessions).toBe(0);
  });

  describe("failure markers", () => {
    it("always fails a chunk that contains the fail marker", async () => {
      const session = await openSession({ failMarker: "[boom]" }).session;

      expect(await attempt(session, "Fine text.")).toBe("ok");
      for (let i = 0; i < 5; i++) {
        expect(await attempt(session, "Text [boom] here.")).toBe("synthesis_failed");
      }
    });

    it("fails a flaky chunk twice, then lets it through, even on a new session", async () => {
      const { engine, session } = openSession({ flakyMarker: "[flaky]" });
      const text = "Text [flaky] here.";

      expect(await attempt(await session, text)).toBe("synthesis_failed");
      expect(await attempt(await engine.open("fake-en"), text)).toBe("synthesis_failed");
      expect(await attempt(await session, text)).toBe("ok");
      expect(await attempt(await session, text)).toBe("ok");
      expect(await attempt(await session, "Another [flaky] chunk.")).toBe("synthesis_failed");
    });
  });
});
