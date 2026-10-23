export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  uk: "Ukrainian",
  ru: "Russian",
};

export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;
