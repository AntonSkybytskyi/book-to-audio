import type { PcmAudio, TtsEngine, TtsSession } from "../tts/engine.js";

export interface SessionHolderOptions {
  /** A session idle for this long is closed, so a quiet app holds no engine processes. */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 60_000;

/**
 * The TTS engine session of one worker. It opens a session on first use and keeps
 * it for the next chunk and the next chapter, as long as the voice stays the same.
 * Any failure closes the session, so the retry gets a fresh engine process.
 */
export class SessionHolder {
  private current: { voiceId: string; session: TtsSession } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: TtsEngine,
    private readonly options: SessionHolderOptions = {},
  ) {}

  /** The engine whose sessions this holds. */
  get engineId(): string {
    return this.engine.id;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  async synthesize(voiceId: string, text: string, signal?: AbortSignal): Promise<PcmAudio> {
    this.stopIdleTimer();
    try {
      if (this.current && this.current.voiceId !== voiceId) await this.close();
      this.current ??= { voiceId, session: await this.engine.open(voiceId) };
      const audio = await this.current.session.synthesize(text, signal);
      this.startIdleTimer();
      return audio;
    } catch (error) {
      await this.close().catch(() => {}); // The failure that matters is the original one.
      throw error;
    }
  }

  /** Stops the engine process and waits for it to be gone. */
  async close(): Promise<void> {
    this.stopIdleTimer();
    const current = this.current;
    this.current = null;
    await current?.session.close();
  }

  private startIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close().catch(() => {});
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
