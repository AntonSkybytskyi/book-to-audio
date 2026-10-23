import { TtsError } from "./errors.js";
import type { PcmAudio } from "./wav.js";

/** One warm engine process for one voice. One chunk at a time; a session that throws is broken. */
export interface Session {
  synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio>;
  close(): Promise<void>;
}

export interface SynthesisPoolOptions {
  /** Most syntheses at once, which is also the most sessions alive at once, across all voices. */
  concurrency: number;
  /** A session nobody used for this long is closed. */
  idleMs: number;
  has(voiceId: string): boolean;
  /** Starts a session for the voice. */
  open(voiceId: string): Promise<Session>;
}

interface Idle {
  voiceId: string;
  session: Session;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Runs at most `concurrency` syntheses at once; more wait their turn, first come first served.
 * Sessions are kept warm after a chunk and reused for the next chunk of the same voice, so a
 * model loads once instead of for every chunk. At most `concurrency` sessions live at once: a
 * new voice closes the session that has been idle the longest.
 */
export class SynthesisPool {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  /** Oldest first. */
  private idle: Idle[] = [];
  private readonly busy = new Set<Session>();
  private readonly closing = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: SynthesisPoolOptions) {}

  /** Sessions alive right now, busy or idle. */
  get sessions(): number {
    return this.busy.size + this.idle.length;
  }

  async synthesize(voiceId: string, text: string, signal?: AbortSignal): Promise<PcmAudio> {
    if (!this.options.has(voiceId)) {
      throw new TtsError("voice_not_found", `This speech service has no voice "${voiceId}".`);
    }
    await this.acquire(signal);
    let session: Session | undefined;
    try {
      session = this.takeIdle(voiceId) ?? (await this.openSession(voiceId));
      this.busy.add(session);
      const audio = await session.synthesize(text, signal);
      this.busy.delete(session);
      this.park(voiceId, session);
      return audio;
    } catch (error) {
      if (session) {
        this.busy.delete(session);
        this.closeSession(session);
      }
      throw error;
    } finally {
      this.release();
    }
  }

  /** Cancels waiting requests and stops every session. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new TtsError("aborted", "The speech service is stopping."));
    }
    for (const { session, timer } of this.idle.splice(0)) {
      clearTimeout(timer);
      this.closeSession(session);
    }
    // Closing a busy session fails its chunk, which then ends up in `closeSession` too.
    for (const session of this.busy) this.closeSession(session);
    while (this.closing.size > 0) await Promise.all(this.closing);
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed)
      return Promise.reject(new TtsError("aborted", "The speech service is stopping."));
    if (signal?.aborted) return Promise.reject(new TtsError("aborted", "Synthesis was cancelled"));
    if (this.running < this.options.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new TtsError("aborted", "Synthesis was cancelled"));
      };
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.resolve(); // the slot passes on
    else this.running--;
  }

  private takeIdle(voiceId: string): Session | undefined {
    const index = this.idle.findLastIndex((idle) => idle.voiceId === voiceId);
    if (index === -1) return undefined;
    const [idle] = this.idle.splice(index, 1);
    clearTimeout(idle?.timer);
    return idle?.session;
  }

  private async openSession(voiceId: string): Promise<Session> {
    // This request holds a slot, so at most `concurrency - 1` sessions are busy and one is idle.
    if (this.sessions >= this.options.concurrency) {
      const oldest = this.idle.shift();
      if (oldest) {
        clearTimeout(oldest.timer);
        this.closeSession(oldest.session);
      }
    }
    return this.options.open(voiceId);
  }

  private park(voiceId: string, session: Session): void {
    if (this.closed) {
      this.closeSession(session);
      return;
    }
    const timer = setTimeout(() => {
      this.idle = this.idle.filter((idle) => idle.session !== session);
      this.closeSession(session);
    }, this.options.idleMs);
    timer.unref();
    this.idle.push({ voiceId, session, timer });
  }

  private closeSession(session: Session): void {
    const closing = session
      .close()
      .catch(() => {})
      .finally(() => this.closing.delete(closing));
    this.closing.add(closing);
  }
}
