import { TtsError, type PcmAudio, type TtsEngine, type TtsSession, type Voice } from "./engine.js";

const SAMPLE_RATE = 22_050;
/** Roughly the pace of spoken English. */
const CHARS_PER_SECOND = 15;
/** The flaky marker fails this many attempts on a chunk, then lets it through. */
const FLAKY_FAILURES = 2;

export interface FakeEngineOptions {
  voices?: Voice[];
  /** Longest text one call accepts; small values make short chapters split into many chunks. */
  maxInputChars?: number;
  /** Pretend synthesis takes this long, so progress is visible in the UI. */
  delayMs?: number;
  /** Any chunk containing this text always fails, like a crashing engine. */
  failMarker?: string;
  /** Any chunk containing this text always fails like text that cannot be read, not like a broken engine. */
  badMarker?: string;
  /** Any chunk containing this text fails its first two attempts, then succeeds. */
  flakyMarker?: string;
}

/**
 * Deterministic engine for development and tests. It needs no binaries and
 * returns a quiet tone whose length scales with the text. The markers make
 * failures reproducible (`FAKE_TTS_FAIL_MARKER`, `FAKE_TTS_FLAKY_MARKER`).
 */
export class FakeEngine implements TtsEngine {
  readonly id = "fake";
  readonly kind = "local";
  readonly maxInputChars: number;
  /** Sessions opened and closed so far, for tests that check nothing is left running. */
  opened = 0;
  closed = 0;
  private readonly voiceList: Voice[];
  private readonly options: FakeEngineOptions;
  private readonly flakyAttempts = new Map<string, number>();

  constructor(options: FakeEngineOptions = {}) {
    this.options = options;
    this.maxInputChars = options.maxInputChars ?? 400;
    this.voiceList = options.voices ?? [
      { id: "fake-en", language: "en", name: "Fake English", sampleRate: SAMPLE_RATE },
    ];
  }

  get openSessions(): number {
    return this.opened - this.closed;
  }

  voices(): Voice[] {
    return [...this.voiceList];
  }

  async open(voiceId: string): Promise<TtsSession> {
    if (!this.voiceList.some((voice) => voice.id === voiceId)) {
      throw new TtsError("voice_not_found", `Unknown voice "${voiceId}"`);
    }
    this.opened++;
    let closed = false;
    const sampleRate =
      this.voiceList.find((voice) => voice.id === voiceId)?.sampleRate ?? SAMPLE_RATE;
    return {
      synthesize: (text, signal) => this.synthesize(text, sampleRate, signal),
      close: async () => {
        if (closed) return;
        closed = true;
        this.closed++;
      },
    };
  }

  private async synthesize(
    text: string,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<PcmAudio> {
    if (text.length > this.maxInputChars) {
      throw new TtsError(
        "synthesis_failed",
        `Text is longer than ${this.maxInputChars} characters`,
      );
    }
    if ((this.options.delayMs ?? 0) > 0) await sleep(this.options.delayMs ?? 0, signal);
    if (signal?.aborted) throw new TtsError("aborted", "Synthesis was cancelled");
    this.injectFailure(text);

    const seconds = Math.max(0.2, text.length / CHARS_PER_SECOND);
    const count = Math.round(seconds * sampleRate);
    const samples = Buffer.alloc(count * 2);
    const fade = Math.round(0.02 * sampleRate);
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - i) / fade);
      const value = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 3000 * envelope;
      samples.writeInt16LE(Math.round(value), i * 2);
    }
    return { sampleRate, channels: 1, samples };
  }

  private injectFailure(text: string): void {
    const { failMarker, flakyMarker, badMarker } = this.options;
    if (badMarker && text.includes(badMarker)) {
      throw new TtsError("bad_input", "The speech engine could not read part of this chapter.", {
        detail: `fake engine: chunk contains the bad marker "${badMarker}"`,
      });
    }
    if (failMarker && text.includes(failMarker)) {
      throw new TtsError("synthesis_failed", "The speech engine failed on this chapter.", {
        detail: `fake engine: chunk contains the fail marker "${failMarker}"`,
      });
    }
    if (flakyMarker && text.includes(flakyMarker)) {
      const attempts = (this.flakyAttempts.get(text) ?? 0) + 1;
      this.flakyAttempts.set(text, attempts);
      if (attempts <= FLAKY_FAILURES) {
        throw new TtsError("synthesis_failed", "The speech engine failed on this chapter.", {
          detail: `fake engine: flaky marker "${flakyMarker}", attempt ${attempts}`,
        });
      }
    }
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
