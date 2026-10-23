import type { Language } from "./languages.js";

/** Most workers the settings accept for one TTS service. */
export const MAX_WORKERS = 64;

/** The workers of one TTS service. */
export interface ServiceWorkersView {
  /** The service's name in `TTS_SERVICES`. */
  id: string;
  /** The service answered the last time it was asked. */
  reachable: boolean;
  /** Requests the service says it handles at once: the default; 0 until it has answered. */
  reported: number;
  /** The number the owner set, or null for the reported one. */
  override: number | null;
  /** Workers in use. */
  workers: number;
}

/** A voice the owner can pick for a language. */
export interface VoiceOptionView {
  /** Starts with the service's name, for example `piper:en_US-lessac-medium`. */
  id: string;
  /** The TTS service it is on. */
  service: string;
  name: string;
  speaker?: string;
}

/** The voice of one language. */
export interface LanguageVoiceView {
  language: Language;
  /** The voice that reads it now, or null while it has none (its service has not answered yet). */
  voice: string | null;
  /** The voice the owner picked, or null for the default: the first voice for the language. */
  chosen: string | null;
  /** Every voice for the language, services in `TTS_SERVICES` order. */
  options: VoiceOptionView[];
}

/** `GET` and `PATCH /api/settings`. */
export interface SettingsView {
  /** One per configured TTS service, in `TTS_SERVICES` order. */
  services: ServiceWorkersView[];
  /** One per language that has a voice, or a chosen one, in the order of `LANGUAGES`. */
  voices: LanguageVoiceView[];
  /** Most workers the settings accept for one service. */
  maxWorkers: number;
  /** The languages the language picker offers, in the order of `LANGUAGES`. */
  shownLanguages: Language[];
}

/** `PATCH /api/settings`: only the fields given change. */
export interface SettingsPatch {
  /** Workers per service; null goes back to the number the service reports. */
  workers?: Record<string, number | null>;
  /** The voice per language; null goes back to the default. */
  voices?: Partial<Record<Language, string | null>>;
  shownLanguages?: Language[];
}

/** `GET /api/config`. */
export interface ConfigView {
  /** Largest accepted upload. */
  maxUploadMb: number;
}
