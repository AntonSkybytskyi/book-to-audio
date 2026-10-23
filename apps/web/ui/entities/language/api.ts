export type Language = "en" | "uk" | "ru";
/** Where a book's language came from; `unknown` means English is only a placeholder. */
export type LanguageSource = "detected" | "metadata" | "unknown" | "chosen";
