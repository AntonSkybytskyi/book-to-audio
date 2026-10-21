import {
  TtsError,
  type PcmAudio,
  type SynthesizeRequest,
  type TtsEngine,
  type Voice,
} from "./engine.js";

const SAMPLE_RATE = 22_050;
/** Roughly the pace of spoken English. */
const CHARS_PER_SECOND = 15;

export interface FakeEngineOptions {
  voices?: Voice[];
  /** Pretend synthesis takes this long, so progress is visible in the UI. */
  delayMs?: number;
}

/**
 * Deterministic engine for development and tests. It needs no binaries and
 * returns a quiet tone whose length scales with the text.
 */
export class FakeEngine implements TtsEngine {
  readonly id = "fake";
  readonly kind = "local";
  readonly maxInputChars = 400;
  private readonly voiceList: Voice[];
  private readonly delayMs: number;

  constructor({ voices, delayMs = 0 }: FakeEngineOptions = {}) {
    this.voiceList = voices ?? [{ id: "fake-en", language: "en", name: "Fake English" }];
    this.delayMs = delayMs;
  }

  voices(): Voice[] {
    return [...this.voiceList];
  }

  async synthesize({ text, voiceId, speed, signal }: SynthesizeRequest): Promise<PcmAudio> {
    if (!this.voiceList.some((voice) => voice.id === voiceId)) {
      throw new TtsError("voice_not_found", `Unknown voice "${voiceId}"`);
    }
    if (text.length > this.maxInputChars) {
      throw new TtsError(
        "synthesis_failed",
        `Text is longer than ${this.maxInputChars} characters`,
      );
    }
    if (this.delayMs > 0) await sleep(this.delayMs, signal);
    if (signal?.aborted) throw new TtsError("aborted", "Synthesis was cancelled");

    const seconds = Math.max(0.2, text.length / CHARS_PER_SECOND / speed);
    const count = Math.round(seconds * SAMPLE_RATE);
    const samples = Buffer.alloc(count * 2);
    const fade = Math.round(0.02 * SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - i) / fade);
      const value = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 3000 * envelope;
      samples.writeInt16LE(Math.round(value), i * 2);
    }
    return { sampleRate: SAMPLE_RATE, channels: 1, samples };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
