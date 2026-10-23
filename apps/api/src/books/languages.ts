import { LANGUAGES, type Language } from "@book-to-audio/contracts";

export { LANGUAGES, type Language };

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  uk: "Ukrainian",
  ru: "Russian",
};

export const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

/** The supported language a `dc:language` value such as `en-GB` names, or null. */
export function declaredLanguage(tag: string | null): Language | null {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isLanguage(primary) ? primary : null;
}
