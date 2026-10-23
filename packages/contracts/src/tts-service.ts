// The HTTP API every TTS service implements. `openapi/tts-service.yaml` describes the same contract.

/** Why a TTS service could not read a text aloud. */
export const TTS_ERROR_CODES = [
  "voice_not_found",
  "bad_input",
  "synthesis_failed",
  "timeout",
  "engine_unavailable",
] as const;
/**
 * `bad_input`: this text cannot be read aloud; says nothing about the service.
 * `engine_unavailable`: the engine could not be started.
 */
export type TtsServiceErrorCode = (typeof TTS_ERROR_CODES)[number];

/** The HTTP status a TTS service answers with for each error code. */
export const TTS_ERROR_STATUS: Readonly<Record<TtsServiceErrorCode, number>> = {
  voice_not_found: 404,
  bad_input: 422,
  synthesis_failed: 500,
  engine_unavailable: 503,
  timeout: 504,
};

/** Body of every error response. */
export interface TtsServiceError {
  code: TtsServiceErrorCode;
  /** One sentence the app can show to the user. */
  message: string;
  /** Technical detail for the logs. */
  detail?: string;
}

export interface TtsServiceVoice {
  /** Unique within the service. The app puts the service name in front of it. */
  id: string;
  /** Two-letter language code, for example `en`. */
  language: string;
  name: string;
  /** Sample rate of the audio the voice produces, in Hz. */
  sampleRate: number;
  /** The speaker of a multi-speaker model. */
  speaker?: string;
}

/** `GET /voices`. */
export interface TtsVoicesResponse {
  /** The service's voices, the ones it prefers first. */
  voices: TtsServiceVoice[];
  /** Longest text, in characters, that one `POST /synthesize` accepts. */
  maxInputChars: number;
  /** How many `POST /synthesize` requests the service handles at once; more wait in its queue. */
  concurrency: number;
}

/** `POST /synthesize`. The answer is a 16-bit mono WAV file. */
export interface TtsSynthesizeRequest {
  voice: string;
  text: string;
}

/** `GET /health`. */
export interface TtsHealthResponse {
  status: "ok";
}

export const TTS_WAV_CONTENT_TYPE = "audio/wav";
