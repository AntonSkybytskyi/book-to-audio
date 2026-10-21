export const LANGUAGES = ["en", "uk", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

export const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

/** Maps a `dc:language` value such as `en-GB` to a supported language, defaulting to English. */
export function languageFromTag(tag: string | null): Language {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isLanguage(primary) ? primary : "en";
}
