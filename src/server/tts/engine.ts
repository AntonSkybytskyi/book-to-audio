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
  readonly kind: "local" | "cloud";
  /** Longest text, in characters, that one `synthesize` call accepts. */
  readonly maxInputChars: number;
  voices(): Voice[];
  open(voiceId: string): Promise<TtsSession>;
}

export type TtsErrorCode =
  | "voice_not_found"
  | "engine_unavailable" // the binary or service could not be started
  | "synthesis_failed"
  | "timeout"
  | "bad_input" // this text cannot be read aloud; says nothing about the engine
  | "aborted";

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
