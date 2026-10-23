import { replaceMatches } from "../replace.js";
import { headingNumeral, isUnambiguousRoman, parseRoman, romanLetters } from "../roman.js";
import type { SlavicConfig } from "./config.js";
import { alternation } from "./context.js";

/**
 * "Глава IV", "в розділі II", "Розділ 4": the numeral takes the gender and case of the word before
 * it. A number written with digits is only a chapter number when the word is capitalised or opens
 * the paragraph and the number ends the phrase: "в главе 3 пункта" counts, it does not number.
 */
export function expandHeadingNumerals(text: string, config: SlavicConfig): string {
  const forms = alternation(Object.keys(config.headings));
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${forms})([\s ]+)(\p{L}{1,4}|\d{1,3})(?![\p{L}\p{N}])(?![.,:/]\d)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const heading = config.headings[(m[1] as string).toLowerCase()];
    if (!heading) return null;
    const atStart = /^[\s"'«“(]*$/u.test(whole.slice(0, m.index));
    if (heading.atStart && !atStart) return null;
    const token = m[3] as string;
    let value: number | null;
    if (/^\d+$/.test(token)) {
      const capitalised = /^\p{Lu}/u.test(m[1] as string);
      const after = whole.slice(m.index + m[0].length);
      const endsPhrase = /^(?:[.:)!?;,]*\s*$|[.:)!?;,]*\s+[\p{Lu}—–-])/u.test(after);
      value = (capitalised || atStart) && endsPhrase ? Number(token) : null;
    } else {
      value = headingNumeral(token, true);
    }
    if (value === null) return null;
    const ordinal = config.numerals.ordinal(value, heading.gender, heading.case);
    return ordinal && `${m[1]}${m[2]}${ordinal}`;
  });
}

/**
 * A paragraph that is only a numeral ("IV", "XII.") is a chapter heading: it is read as the
 * number. `spell` turns the value into words, or digits for an engine that reads those itself.
 */
export function expandBareNumeral(text: string, spell: (value: number) => string): string {
  const letters = romanLetters(true);
  return text.replace(
    new RegExp(String.raw`^(\s*)([${letters}]{1,12})(\.?\s*)$`, "u"),
    (all, a, token, b) => {
      const value = isUnambiguousRoman(token) ? headingNumeral(token, true) : null;
      return value === null ? all : `${a}${spell(value)}${b}`;
    },
  );
}

/** "IV. Title": a numeral of two or more letters, a dot and a capital word. */
export function expandNumberedTitle(text: string, spell: (value: number) => string): string {
  const letters = romanLetters(true);
  const pattern = new RegExp(String.raw`^(\s*)([${letters}]{2,12})\.(?=\s+\p{Lu})`, "u");
  return text.replace(pattern, (all, a, token) => {
    const value = parseRoman(token, true) === null ? null : headingNumeral(token, true);
    return value === null ? all : `${a}${spell(value)}.`;
  });
}
