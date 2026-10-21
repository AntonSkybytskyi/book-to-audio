import { UserFacingError } from "../errors.js";

export interface Voice {
  id: string;
  /** Two-letter language code, for example `en`. */
  language: string;
  name: string;
}

/** Raw 16-bit little-endian mono PCM. */
export interface PcmAudio {
  sampleRate: number;
  channels: 1;
  samples: Buffer;
}

export interface SynthesizeRequest {
  text: string;
  voiceId: string;
  /** 1.0 is normal speed. */
  speed: number;
  signal?: AbortSignal;
}

export interface TtsEngine {
  readonly id: string;
  readonly kind: "local" | "cloud";
  /** Longest text, in characters, that one `synthesize` call accepts. */
  readonly maxInputChars: number;
  voices(): Voice[];
  synthesize(request: SynthesizeRequest): Promise<PcmAudio>;
}

export type TtsErrorCode =
  | "voice_not_found"
  | "engine_unavailable" // the binary or service could not be started
  | "synthesis_failed"
  | "timeout"
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
