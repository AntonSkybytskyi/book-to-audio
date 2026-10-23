import { describe, expect, it, vi } from "vitest";
import { prepareChunks } from "../convert/chapter-text.js";
import { TimedEngine } from "../testing/timed-engine.js";
import { TtsError, type TtsEngine, type TtsSession } from "../tts/engine.js";
import { measureVoice, type MeasureDeps } from "./measure.js";
import { BENCHMARK_SAMPLES } from "./samples.js";

const deps = (engine: TimedEngine, overrides: Partial<MeasureDeps> = {}): MeasureDeps => ({
  engine,
  prepare: prepareChunks,
  scratchDir: "/nonexistent",
  now: engine.now,
  ...overrides,
});

const english = (engine: TimedEngine) => engine.voices()[0]!;

describe("measureVoice", () => {
  it("measures the speech rate in audio per 1,000 characters of prepared text", async () => {
    const engine = new TimedEngine({ audioPerChar: 0.06 });

    const result = await measureVoice(deps(engine), english(engine), { workerCounts: [1] });

    expect(result.secondsPerKChar).toBeCloseTo(60, 6);
    expect(result.voiceId).toBe("timed-en");
    expect(result.language).toBe("en");
    expect(result.engine).toBe("timed");
  });

  it("counts the characters the engine is given, not the raw sample", async () => {
    const engine = new TimedEngine();

    const result = await measureVoice(deps(engine), english(engine), {
      workerCounts: [1],
      repeat: 1,
    });

    const chunks = prepareChunks(BENCHMARK_SAMPLES.en, "en", engine.maxInputChars);
    expect(result.sampleChars).toBe(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    expect(result.sampleChars).not.toBe(BENCHMARK_SAMPLES.en.length); // "$15" and "1987" were spelled out
    expect(result.sampleAudioSeconds).toBeCloseTo(result.sampleChars * 0.06, 6);
  });

  it("reports the real-time factor of one session, with the model load apart", async () => {
    const engine = new TimedEngine({ msPerChar: 12, audioPerChar: 0.06, loadMs: 700 });

    const result = await measureVoice(deps(engine), english(engine), { workerCounts: [1] });

    // 12 ms of work for 60 ms of audio.
    expect(result.rtf).toBeCloseTo(0.2, 6);
    // The model load is the open plus the warm-up line, and is not in the factor.
    expect(result.modelLoadMs).toBe(700 + "Getting the voice ready.".length * 12);
  });

  it("reads a short warm-up line before timing anything", async () => {
    const engine = new TimedEngine();

    await measureVoice(deps(engine), english(engine), { workerCounts: [1], repeat: 1 });

    expect(engine.texts[0]).toBe("Getting the voice ready.");
    const chunks = prepareChunks(BENCHMARK_SAMPLES.en, "en", engine.maxInputChars);
    expect(engine.texts.slice(1)).toEqual(chunks);
  });

  it("measures the throughput with several sessions at once, where sessions slow each other down", async () => {
    const engine = new TimedEngine({
      msPerChar: 10,
      audioPerChar: 0.05, // one session alone: 5 audio seconds per second
      contention: (active) => (active === 1 ? 1 : active === 2 ? 1.6 : 2.4),
    });

    const result = await measureVoice(deps(engine), english(engine), { workerCounts: [1, 2, 3] });

    const at = (n: number) => result.throughput.find((p) => p.workers === n)?.audioPerSecond;
    expect(at(1)).toBeCloseTo(5, 3);
    expect(at(2)).toBeCloseTo((2 / 1.6) * 5, 3);
    expect(at(3)).toBeCloseTo((3 / 2.4) * 5, 3);
    expect(result.throughput.map((p) => p.workers)).toEqual([1, 2, 3]);
  });

  it("always measures one session first, and each count once, in order", async () => {
    const engine = new TimedEngine();

    const result = await measureVoice(deps(engine), english(engine), { workerCounts: [3, 2, 3] });

    expect(result.throughput.map((p) => p.workers)).toEqual([1, 2, 3]);
  });

  it("reading the sample more times does not change the per-pass numbers", async () => {
    const once = new TimedEngine();
    const thrice = new TimedEngine();

    const a = await measureVoice(deps(once), english(once), { workerCounts: [1], repeat: 1 });
    const b = await measureVoice(deps(thrice), english(thrice), { workerCounts: [1], repeat: 3 });

    expect(b.secondsPerKChar).toBeCloseTo(a.secondsPerKChar, 6);
    expect(b.sampleAudioSeconds).toBeCloseTo(a.sampleAudioSeconds, 6);
    expect(b.rtf).toBeCloseTo(a.rtf, 6);
  });

  it("measures the Opus encoding when an encoder is given, and says nothing when not", async () => {
    const engine = new TimedEngine({ audioPerChar: 0.06 });
    const encodes: string[] = [];
    const encode: NonNullable<MeasureDeps["encode"]> = async (pcm, file) => {
      encodes.push(file);
      const seconds = (pcm.samples as Buffer).length / 2 / pcm.sampleRate;
      engine.clock += seconds * 10; // 10 ms per second of audio
      return { durationSeconds: seconds };
    };
    const directory = (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "measure-"),
    );

    const withEncoder = await measureVoice(
      deps(engine, { encode, scratchDir: directory }),
      english(engine),
      {
        workerCounts: [1],
      },
    );
    const without = await measureVoice(deps(new TimedEngine()), english(engine), {
      workerCounts: [1],
    });

    expect(withEncoder.encodeFactor).toBeCloseTo(0.01, 6);
    expect(without.encodeFactor).toBeNull();
    expect(encodes.length).toBeGreaterThan(0);
    expect(new Set(encodes).size).toBe(encodes.length); // each chunk to its own file
    (await import("node:fs")).rmSync(directory, { recursive: true, force: true });
  });

  it("includes the encoding in the throughput, as a conversion does the same work", async () => {
    const engine = new TimedEngine({ msPerChar: 10, audioPerChar: 0.05 });
    const encode: NonNullable<MeasureDeps["encode"]> = async (pcm) => {
      const seconds = (pcm.samples as Buffer).length / 2 / pcm.sampleRate;
      engine.clock += seconds * 100; // 100 ms per second of audio: 0.5 s of encoding per 5 s of audio
      return { durationSeconds: seconds };
    };

    const result = await measureVoice(
      deps(engine, { encode, scratchDir: "/tmp" }),
      english(engine),
      {
        workerCounts: [1],
      },
    );

    // Per second of audio: 0.2 s of synthesis and 0.1 s of encoding.
    expect(result.throughput[0]?.audioPerSecond).toBeCloseTo(1 / 0.3, 3);
    expect(result.rtf).toBeCloseTo(0.2, 6);
  });

  it("closes every session it opened", async () => {
    const engine = new TimedEngine();

    await measureVoice(deps(engine), english(engine), { workerCounts: [1, 2, 4] });

    expect(engine.opened).toBe(1 + 2 + 4);
    expect(engine.openSessions).toBe(0);
  });

  it("closes the sessions and reports progress after each step", async () => {
    const engine = new TimedEngine();
    const shares: number[] = [];

    await measureVoice(deps(engine), english(engine), {
      workerCounts: [1, 2],
      onProgress: (share) => shares.push(share),
    });

    expect(shares).toEqual([0.5, 1]);
  });

  it("closes the sessions when the engine fails part way", async () => {
    const engine = new TimedEngine();
    const failing: TtsEngine = {
      id: engine.id,
      kind: "local",
      maxInputChars: engine.maxInputChars,
      voices: () => engine.voices(),
      async open(voiceId) {
        const session = await engine.open(voiceId);
        let calls = 0;
        return {
          synthesize: async (text, signal) => {
            if (++calls === 3) throw new TtsError("synthesis_failed", "Piper crashed.");
            return session.synthesize(text, signal);
          },
          close: () => session.close(),
        } satisfies TtsSession;
      },
    };

    await expect(
      measureVoice({ ...deps(engine), engine: failing }, english(engine), { workerCounts: [1, 2] }),
    ).rejects.toThrow("Piper crashed.");
    expect(engine.openSessions).toBe(0);
  });

  it("closes a session that finishes opening after another one failed", async () => {
    const engine = new TimedEngine();
    let opens = 0;
    let slow: ((session: TtsSession) => void) | null = null;
    const racing: TtsEngine = {
      id: engine.id,
      kind: "local",
      maxInputChars: engine.maxInputChars,
      voices: () => engine.voices(),
      async open(voiceId) {
        const call = ++opens;
        // The single-session step goes through; in the two-session step the first open fails at once
        // and the second is still being opened until the test lets it finish.
        if (call === 1) return engine.open(voiceId);
        if (call === 2) throw new TtsError("synthesis_failed", "Piper crashed on start.");
        const session = await engine.open(voiceId);
        return new Promise<TtsSession>((resolve) => (slow = () => resolve(session)));
      },
    };

    const result = measureVoice({ ...deps(engine), engine: racing }, english(engine), {
      workerCounts: [1, 2],
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(slow).not.toBeNull());
    let settled = false;
    void result.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // it waits for the session that is still opening
    (slow as (() => void) | null)?.();

    expect(await result).toMatchObject({ message: "Piper crashed on start." });
    expect(engine.opened).toBeGreaterThanOrEqual(2);
    expect(engine.openSessions).toBe(0);
  });

  it("stops and closes the sessions when cancelled", async () => {
    const engine = new TimedEngine();
    const controller = new AbortController();
    const promise = measureVoice(deps(engine), english(engine), {
      workerCounts: [1, 2],
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(promise).rejects.toMatchObject({ code: "aborted" });
    expect(engine.openSessions).toBe(0);
    expect(engine.opened).toBe(1); // the second step never opened its sessions
  });

  it("has no text for a language it does not know", async () => {
    const engine = new TimedEngine({
      voices: [{ id: "de", language: "de", name: "Deutsch", sampleRate: 22_050 }],
    });

    await expect(
      measureVoice(deps(engine), engine.voices()[0]!, { workerCounts: [1] }),
    ).rejects.toMatchObject({ code: "bad_input" });
  });

  it("refuses a voice that produces no audio", async () => {
    const engine = new TimedEngine({ audioPerChar: 0 });

    await expect(
      measureVoice(deps(engine), english(engine), { workerCounts: [1] }),
    ).rejects.toThrow(/no audio/);
    expect(engine.openSessions).toBe(0);
  });
});
