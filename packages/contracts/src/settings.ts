import type { Language } from "./languages.js";

/** `GET` and `PATCH /api/settings`. */
export interface SettingsView {
  workers: number;
  /** Most workers the settings accept. */
  maxWorkers: number;
  /** Used until the owner picks a number. */
  defaultWorkers: number;
  /** The languages the language picker offers, in the order of `LANGUAGES`. */
  shownLanguages: Language[];
}

/** `GET /api/config`. */
export interface ConfigView {
  /** Largest accepted upload. */
  maxUploadMb: number;
}
