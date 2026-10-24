import {
  TtsError,
  type PcmAudio,
  type TtsEngine,
  type TtsSession,
  type Voice,
} from "../tts/engine.js";

export interface TimedEngineOptions {
  voices?: Voice[];
  /** Milliseconds one character of text costs when a session is alone. */
  msPerChar?: number;
  /** Seconds of audio one character becomes. */
  audioPerChar?: number;
  /** Milliseconds `open` takes (the model loading). */
  loadMs?: number;
  /** How many times slower each session is while `active` of them are open. Defaults to no slowdown. */
  contention?: (active: number) => number;
  maxInputChars?: number;
  concurrency?: number;
}

/**
 * An engine with a clock of its own, so speed measurements are exact. Time only moves when a
 * session works: each call advances the clock by its cost divided by the number of open sessions,
 * which is what parallel sessions that all do the same work add up to.
 */
export class TimedEngine implements TtsEngine {
  readonly id = "timed";
  readonly concurrency: number;
  readonly ready = true;
  reachable = true;
  readonly maxInputChars: number;
  /** Milliseconds on the engine's clock. */
  clock = 0;
  opened = 0;
  closed = 0;
  /** The texts read, in order. */
  readonly texts: string[] = [];
  /** While set, every read waits for it (and fails like a killed process when cancelled). */
  stall: Promise<void> | null = null;
  private readonly options: Required<Omit<TimedEngineOptions, "voices">> & { voices: Voice[] };

  constructor(options: TimedEngineOptions = {}) {
    this.options = {
      voices: [{ id: "timed-en", language: "en", name: "Timed", sampleRate: 22_050 }],
      msPerChar: 10,
      audioPerChar: 0.06,
      loadMs: 500,
      contention: () => 1,
      maxInputChars: 400,
      concurrency: 4,
      ...options,
    };
    this.maxInputChars = this.options.maxInputChars;
    this.concurrency = this.options.concurrency;
  }

  readonly now = (): number => this.clock;

  get openSessions(): number {
    return this.opened - this.closed;
  }

  voices(): Voice[] {
    return [...this.options.voices];
  }

  async open(voiceId: string): Promise<TtsSession> {
    const voice = this.options.voices.find((v) => v.id === voiceId);
    if (!voice) throw new TtsError("voice_not_found", `Unknown voice "${voiceId}"`);
    this.opened++;
    this.clock += this.options.loadMs / Math.max(1, this.openSessions);
    let closed = false;
    return {
      synthesize: async (text, signal) => {
        if (signal?.aborted) throw new TtsError("aborted", "Synthesis was cancelled");
        if (this.stall) await this.waitStalled(this.stall, signal);
        return this.read(text, voice.sampleRate);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.closed++;
      },
    };
  }

  private waitStalled(stall: Promise<void>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new TtsError("aborted", "Synthesis was cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      void stall.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  private read(text: string, sampleRate: number): PcmAudio {
    const { msPerChar, audioPerChar, contention } = this.options;
    const active = Math.max(1, this.openSessions);
    this.clock += (text.length * msPerChar * contention(active)) / active;
    this.texts.push(text);
    const samples = Math.round(text.length * audioPerChar * sampleRate);
    return { sampleRate, channels: 1, samples: Buffer.alloc(samples * 2) };
  }
}
