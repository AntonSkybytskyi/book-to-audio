import type { TtsServiceErrorCode } from "@book-to-audio/contracts";
import { UserFacingError } from "../errors.js";

export interface Voice {
  id: string;
  /** Two-letter language code, for example `en`. */
  language: string;
  name: string;
  /** Sample rate of the audio the voice produces, in Hz. */
  sampleRate: number;
  /** The speaker of a multi-speaker model. It is part of `id`, so a change of speaker is a different voice. */
  speaker?: string;
}

/** Raw 16-bit little-endian mono PCM. */
export interface PcmAudio {
  sampleRate: number;
  channels: 1;
  samples: Buffer;
}

/**
 * A long-lived connection to one voice, so the model is loaded once and then
 * reused for every chunk. One caller at a time. A session that throws is broken:
 * close it and open a new one.
 */
export interface TtsSession {
  synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio>;
  /** Stops the engine process and waits until it is gone. Safe to call twice. */
  close(): Promise<void>;
}

export interface TtsEngine {
  readonly id: string;
  /** Longest text, in characters, that one `synthesize` call accepts. */
  readonly maxInputChars: number;
  /** How many sessions the engine serves at once; more wait their turn. */
  readonly concurrency: number;
  /** The engine said which voices it has at least once, so `voices()` is not just empty for want of an answer. */
  readonly ready: boolean;
  /** The engine answered the last time it was asked. */
  readonly reachable: boolean;
  voices(): Voice[];
  open(voiceId: string): Promise<TtsSession>;
}

/**
 * The service's codes (`bad_input`: this text cannot be read aloud, says nothing about the engine),
 * plus two of the app's own: `aborted`, the app cancelled the work; `unreachable`, the service did
 * not answer at all, which says nothing about the text either.
 */
export type TtsErrorCode = TtsServiceErrorCode | "aborted" | "unreachable";

export class TtsError extends UserFacingError {
  readonly code: TtsErrorCode;

  constructor(code: TtsErrorCode, message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.name = "TtsError";
    this.code = code;
  }
}

/** The voice used for a language, or undefined when the engine has none. */
export function pickVoice(engine: TtsEngine, language: string): Voice | undefined {
  return engine.voices().find((voice) => voice.language === language);
}
