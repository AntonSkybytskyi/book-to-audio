/** Languages the app can read aloud, in the order the pages list them. */
export const LANGUAGES = ["en", "uk", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Where a book's language came from; `unknown` means English is only a placeholder. */
export type LanguageSource = "detected" | "metadata" | "unknown" | "chosen";
