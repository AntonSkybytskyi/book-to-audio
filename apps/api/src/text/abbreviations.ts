import { previousWord, replaceMatches } from "./replace.js";

/** What an abbreviation is read as, and where it is allowed to be expanded. */
export interface AbbreviationRule {
  /** Regex source of the abbreviation with its dots, for example `т\.\s?д\.`. */
  pattern: string;
  /** The words; a function gets the lowercase word before the abbreviation and may decline by returning null. */
  words: string | ((previous: string) => string | null);
  /** Match capital letters too (`i` flag). Off for abbreviations that are case sensitive. */
  ignoreCase?: boolean;
  /** Only where the next word starts with a capital ("г. Москва"). */
  beforeCapital?: boolean;
  /** Only before a digit ("p. 12"). */
  beforeNumber?: boolean;
  /** Only after a digit ("5 ft."). */
  afterNumber?: boolean;
  /** Not after a digit ("см. рисунок", but "5 см"). */
  notAfterNumber?: boolean;
  /** Only after a word that starts with a capital ("Martin Luther King Jr."). */
  afterCapitalWord?: boolean;
  /**
   * Only after a noun that starts with one of these stems ("школа им. Пушкина"), or before initials
   * ("им. А. С. Пушкина"): "им" is also the pronoun ("сказал им. Потом").
   */
  afterNounStems?: readonly string[];
  /** The dot is also the end of the sentence when a capital letter follows: it is put back. */
  mayEndSentence?: boolean;
}

const nextChar = (text: string, index: number) => /^[\s\u00A0]*(\S)/u.exec(text.slice(index))?.[1];
const previousChar = (text: string, index: number) =>
  /(\S)[\s\u00A0]*$/u.exec(text.slice(Math.max(0, index - 20), index))?.[1];

/** Expands the abbreviations of a language. Rules are tried in order on the whole text. */
export function expandAbbreviations(text: string, rules: readonly AbbreviationRule[]): string {
  let result = text;
  for (const rule of rules) {
    const flags = rule.ignoreCase ? "giu" : "gu";
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:${rule.pattern})(?![\p{L}\p{N}])`,
      flags,
    );
    result = replaceMatches(result, pattern, (m, whole) => {
      const end = m.index + m[0].length;
      const next = nextChar(whole, end);
      const before = previousChar(whole, m.index);
      if (rule.beforeCapital && !(next && /\p{Lu}/u.test(next))) return null;
      if (rule.beforeNumber && !(next && /\d/.test(next))) return null;
      if (rule.afterNumber && !(before && /\d/.test(before))) return null;
      if (rule.notAfterNumber && before && /\d/.test(before)) return null;
      if (
        rule.afterCapitalWord &&
        !/\p{Lu}[\p{L}'.-]*,?[\s\u00A0]+$/u.test(whole.slice(Math.max(0, m.index - 40), m.index))
      ) {
        return null;
      }
      if (rule.afterNounStems) {
        // "вул. ім.": the word before may be an abbreviation with its own dot.
        const previous =
          /(\p{L}+)\.?[\s\u00A0]*$/u
            .exec(whole.slice(Math.max(0, m.index - 40), m.index))?.[1]
            ?.toLowerCase() ?? "";
        const afterNoun = rule.afterNounStems.some((stem) => previous.startsWith(stem));
        const beforeInitials = /^[\s\u00A0]*\p{Lu}\.[\s\u00A0]?\p{Lu}\./u.test(whole.slice(end));
        if (!afterNoun && !beforeInitials) return null;
      }
      const words =
        typeof rule.words === "string" ? rule.words : rule.words(previousWord(whole, m.index));
      if (words === null) return null;
      const dot = rule.mayEndSentence && (!next || /\p{Lu}/u.test(next)) ? "." : "";
      // "Див. рис." at the start of a sentence stays capitalised, so the sentence still starts with a capital.
      const capital = /^\p{Lu}/u.test(m[0])
        ? words.charAt(0).toUpperCase() + words.slice(1)
        : words;
      return capital + dot;
    });
  }
  return result;
}
