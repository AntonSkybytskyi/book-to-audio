import { replaceMatches } from "../replace.js";
import { parseRoman } from "../roman.js";
import type { SlavicConfig } from "./config.js";

const MAX_REGNAL = 39;

/**
 * "Людовик XIV" as "Людовик Чотирнадцятий", "Петра I" as "Петра Первого": the numeral follows the
 * name in gender and case, which is only known for the names in `config.regnal`. A single I, V or X
 * must be Latin, and not an initial ("Іван І. Франко").
 */
export function expandRegnal(text: string, config: SlavicConfig): string {
  const pattern = /(?<![\p{L}\p{N}])(\p{Lu}\p{Ll}+)([\s ]+)([IVXІХ]{1,6})(?![\p{L}\p{N}])/gu;
  return replaceMatches(text, pattern, (m, whole) => {
    const name = config.regnal[(m[1] as string).toLowerCase()];
    const token = m[3] as string;
    const value = parseRoman(token, true);
    if (!name || value === null || value > MAX_REGNAL) return null;
    if (token.length === 1 && /[ІХ]/u.test(token)) return null;
    if (token.length === 1 && /^\.[\s ]+\p{Lu}/u.test(whole.slice(m.index + m[0].length))) {
      return null;
    }
    const ordinal = config.numerals.ordinal(value, name.gender, name.case);
    // The numeral is part of the name: "Людовик Чотирнадцятий".
    return ordinal && `${m[1]}${m[2]}${ordinal.charAt(0).toUpperCase()}${ordinal.slice(1)}`;
  });
}
