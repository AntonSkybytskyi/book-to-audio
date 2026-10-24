import type { TtsEngine, Voice } from "./engine.js";

/** A voice with the engine (TTS service) it lives on. */
export interface CatalogVoice extends Voice {
  engine: string;
}

export interface CatalogLogger {
  info(message: string): void;
  error?(context: object, message: string): void;
}

export interface TtsCatalogOptions {
  /** The voice the owner chose for a language, if any. */
  chosenVoice?: (language: string) => string | undefined;
  /** How often a service that answers is asked for its voices again. */
  pollMs?: number;
  /** How often a service that does not answer is tried again. */
  downPollMs?: number;
  logger?: CatalogLogger;
}

/** Engines that are asked for their voices; in-memory ones have them from the start. */
interface Refreshable {
  refresh(): Promise<boolean>;
}
const refreshable = (engine: TtsEngine): engine is TtsEngine & Refreshable =>
  typeof (engine as Partial<Refreshable>).refresh === "function";

/** Used to split text when a language has no voice yet, so counting the text still works. */
export const DEFAULT_MAX_INPUT_CHARS = 1000;

/**
 * Every configured TTS service, in `TTS_SERVICES` order, and the voice each language is read by:
 * the one the owner chose, else the first voice for the language, services in order and each
 * service's voices in its own order.
 */
export class TtsCatalog {
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(
    private readonly list: readonly TtsEngine[],
    private readonly options: TtsCatalogOptions = {},
  ) {}

  engines(): readonly TtsEngine[] {
    return this.list;
  }

  engine(id: string): TtsEngine | undefined {
    return this.list.find((engine) => engine.id === id);
  }

  voices(): CatalogVoice[] {
    return this.list.flatMap((engine) =>
      engine.voices().map((voice) => ({ ...voice, engine: engine.id })),
    );
  }

  voice(id: string): CatalogVoice | undefined {
    return this.voices().find((voice) => voice.id === id);
  }

  engineOfVoice(voiceId: string): TtsEngine | undefined {
    const voice = this.voice(voiceId);
    return voice && this.engine(voice.engine);
  }

  /**
   * The voice a language is read by, or undefined when there is none. A chosen voice on a service
   * that has not answered yet is waited for, not replaced, so a restart does not change the voice.
   */
  voiceFor(language: string): CatalogVoice | undefined {
    const voices = this.voices();
    const chosen = this.options.chosenVoice?.(language);
    if (chosen !== undefined) {
      const voice = voices.find((v) => v.id === chosen && v.language === language);
      if (voice) return voice;
      const service = this.engine(chosen.slice(0, chosen.indexOf(":")));
      if (service && !service.ready) return undefined;
    }
    return voices.find((voice) => voice.language === language);
  }

  /** The languages whose voice is on this engine: the chapters its workers take. */
  languagesOn(engineId: string): string[] {
    return this.availableLanguages().filter(
      (language) => this.voiceFor(language)?.engine === engineId,
    );
  }

  /** Languages that have a voice, in the order the services list them. */
  availableLanguages(): string[] {
    const languages = [...new Set(this.voices().map((voice) => voice.language))];
    return languages.filter((language) => this.voiceFor(language) !== undefined);
  }

  /** Longest text one request for the language's voice accepts. */
  maxCharsFor(language: string): number {
    const voice = this.voiceFor(language);
    return (voice && this.engine(voice.engine)?.maxInputChars) ?? DEFAULT_MAX_INPUT_CHARS;
  }

  /** Called whenever an engine's voices, limits or reachability change. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks one engine, or all of them, for their voices again. */
  async refresh(engineId?: string): Promise<void> {
    const engines = engineId === undefined ? this.list : this.list.filter((e) => e.id === engineId);
    const changed = await Promise.all(engines.map((engine) => this.refreshOne(engine)));
    if (changed.some(Boolean)) this.changed();
  }

  /** Keeps asking the engines for their voices: often while one is down, now and then once it answers. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const engine of this.list) {
      if (refreshable(engine)) this.schedule(engine);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Asks the engine again after the short delay of a service that is down, not straight away: for
   * when a request just found it gone, so its chapters wait a moment instead of trying at once.
   */
  checkSoon(engineId: string): void {
    const engine = this.engine(engineId);
    if (!this.running || !engine || !refreshable(engine)) return;
    this.schedule(engine);
  }

  private schedule(engine: TtsEngine): void {
    clearTimeout(this.timers.get(engine.id));
    const delay = engine.reachable
      ? (this.options.pollMs ?? 30_000)
      : (this.options.downPollMs ?? 5000);
    const timer = setTimeout(() => {
      void this.refreshOne(engine)
        .then((changed) => {
          if (changed) this.changed();
        })
        .finally(() => {
          if (this.running) this.schedule(engine);
        });
    }, delay);
    timer.unref();
    this.timers.set(engine.id, timer);
  }

  private async refreshOne(engine: TtsEngine): Promise<boolean> {
    if (!refreshable(engine)) return false;
    const wasReachable = engine.reachable;
    const changed = await engine.refresh().catch(() => false);
    if (engine.reachable !== wasReachable) {
      this.options.logger?.info(
        `TTS service "${engine.id}" ${engine.reachable ? `answers, ${engine.voices().length} voices` : "does not answer"}`,
      );
    }
    return changed;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.options.logger?.error?.({ err: error }, "a listener of the TTS catalog failed");
      }
    }
  }
}
