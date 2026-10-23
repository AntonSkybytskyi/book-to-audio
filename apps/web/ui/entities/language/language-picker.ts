import type { Language, LanguageSource } from "./api";
import { languageName } from "./language-names";

export const ALL_LANGUAGES: Language[] = ["en", "uk", "ru"];

export interface PickerOption {
  code: Language;
  label: string;
}

/**
 * The options of the language select: the languages shown in the settings, plus the book's own
 * language when it is a hidden one (a detected Russian book stays selected), marked as hidden.
 */
export function pickerOptions(
  shown: readonly Language[],
  current: Language,
  availableVoices: readonly string[],
): PickerOption[] {
  const codes = ALL_LANGUAGES.filter((code) => shown.includes(code) || code === current);
  return codes.map((code) => {
    const notes: string[] = [];
    if (!shown.includes(code)) notes.push("hidden in settings");
    if (!availableVoices.includes(code)) notes.push("no voice yet");
    return {
      code,
      label: notes.length > 0 ? `${languageName(code)} (${notes.join(", ")})` : languageName(code),
    };
  });
}

export interface LanguageNote {
  /** Short, stated first: "Detected: Ukrainian". Null when there is nothing to say about the origin. */
  headline: string | null;
  text: string;
  tone: "info" | "check";
}

const READ_IN_DEFAULT_VOICE = "The book is read in the default voice for this language.";

/** What the preview says about where the pre-selected language came from. */
export function languageNote(
  source: LanguageSource,
  language: Language,
  declared: string | null,
  userPicked: boolean,
): LanguageNote {
  const name = languageName(language);
  if (userPicked || source === "chosen") {
    return { headline: null, text: READ_IN_DEFAULT_VOICE, tone: "info" };
  }
  if (source === "detected") {
    const disagrees = declared !== null && declared !== language;
    const aside = disagrees
      ? ` The book's metadata says ${languageName(declared)}, but the text is ${name}.`
      : "";
    return {
      headline: `Detected: ${name}`,
      text: `${READ_IN_DEFAULT_VOICE}${aside}`,
      tone: "info",
    };
  }
  if (source === "metadata") {
    return {
      headline: `From the book's metadata: ${name}`,
      text: "The text was too short or too mixed to tell. Please check the language before converting.",
      tone: "check",
    };
  }
  return {
    headline: "Could not detect the language",
    text: "This book may be in a language the app cannot read yet. Please pick the right one before converting.",
    tone: "check",
  };
}

/** The line under the language list after a change was saved: "Shown: English and Ukrainian." */
export function languageSettingsMessage(shown: readonly Language[]): string {
  const names = ALL_LANGUAGES.filter((code) => shown.includes(code)).map(languageName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `Saved. The language list shows ${list}.`;
}

/**
 * A book whose language nobody could tell is not converted until the owner has picked one: the
 * English that is pre-selected is only a placeholder, and one click must not read a German book
 * as English.
 */
export const needsLanguageChoice = (source: LanguageSource, picked: boolean): boolean =>
  source === "unknown" && !picked;
