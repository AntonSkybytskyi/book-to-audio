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

/** `GET` and `PATCH /api/settings`. */
export interface SettingsView {
  /** One per configured TTS service, in `TTS_SERVICES` order. */
  services: ServiceWorkersView[];
  /** Most workers the settings accept for one service. */
  maxWorkers: number;
  /** The languages the language picker offers, in the order of `LANGUAGES`. */
  shownLanguages: Language[];
}

/** `PATCH /api/settings`: only the fields given change. */
export interface SettingsPatch {
  /** Workers per service; null goes back to the number the service reports. */
  workers?: Record<string, number | null>;
  shownLanguages?: Language[];
}

/** `GET /api/config`. */
export interface ConfigView {
  /** Largest accepted upload. */
  maxUploadMb: number;
}
