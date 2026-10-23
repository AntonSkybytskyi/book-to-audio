const VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
/** Cyrillic capitals that look like Roman digits, which Ukrainian and Russian books often use. */
const LOOKALIKES: Record<string, string> = { І: "I", Х: "X", С: "C", М: "M" };

const CANONICAL = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

/** Letters a Roman numeral is made of (Latin, plus the Cyrillic look-alikes when `cyrillic`). */
export const romanLetters = (cyrillic: boolean) => (cyrillic ? "IVXLCDMІХСМ" : "IVXLCDM");

/**
 * The value of an upper-case Roman numeral in its standard written form (IV, not IIII), 1 to
 * 3999, else null. With `cyrillic`, the Cyrillic look-alikes І Х С М count as I X C M.
 */
export function parseRoman(token: string, cyrillic = false): number | null {
  const latin = cyrillic ? [...token].map((c) => LOOKALIKES[c] ?? c).join("") : token;
  if (!latin || !CANONICAL.test(latin)) return null;
  let total = 0;
  for (let i = 0; i < latin.length; i++) {
    const value = VALUES[latin[i] as string] as number;
    const next = VALUES[latin[i + 1] ?? ""] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

/** One-letter numerals other than I, V, X are far more often something else (a grade, a vitamin). */
export const isUnambiguousRoman = (token: string): boolean =>
  token.length > 1 || /^[IVXІХ]$/.test(token);

/** Largest numeral a chapter, part or century is numbered with (Psalm CXIX is 119). */
const MAX_HEADING_NUMERAL = 150;

/**
 * A numeral that may follow a heading word (Chapter, Глава, Розділ): standard form, made of I V X
 * L C (and the Cyrillic look-alikes), at most 150, and a single letter only when it is I, V or X.
 * "Appendix C", "Section D", "Part MIX" are labels, not numbers.
 */
export function headingNumeral(token: string, cyrillic = false): number | null {
  const value = parseRoman(token, cyrillic);
  if (value === null || value > MAX_HEADING_NUMERAL || !isUnambiguousRoman(token)) return null;
  return /[DM\u041C]/u.test(token) ? null : value;
}

/**
 * A numeral of two or more letters made of I, V, X only (II, IV, XIX, XXI), at most 39: safe to read
 * as a number where no heading word or century word says so (Ukrainian text, where a Latin token
 * would otherwise be spelled as a word).
 */
export function plainNumeral(token: string): number | null {
  if (token.length < 2 || !/^[IVX]+$/.test(token)) return null;
  const value = parseRoman(token);
  return value !== null && value <= 39 ? value : null;
}
