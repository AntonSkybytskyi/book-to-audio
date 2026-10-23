import type { Case } from "./numerals.js";
import type { SlavicConfig } from "./config.js";

/** A sentence ends after an expanded abbreviation when the next word starts with a capital. */
export const dotIfSentenceEnds = (text: string, index: number): string =>
  /^[\s"'«“(]*(\p{Lu}|$)/u.test(text.slice(index)) ? "." : "";

/** A number that is not part of a longer one, a decimal, a date, a time or a range. */
export const NOT_IN_NUMBER = String.raw`(?<![\p{L}\p{N}.,/:-])`;

/** The year numbers the rules read as years. */
export const isYear = (n: number): boolean => n >= 1000 && n <= 2099;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** `a|b|c` for a regex, longest first so that "ого" is tried before "го". */
export const alternation = (words: readonly string[]): string =>
  words
    .toSorted((a, b) => b.length - a.length)
    .map(escape)
    .join("|");

/** The case a preposition before a year or a century asks for, null when the word is not one. */
export function caseAfterPreposition(config: SlavicConfig, previous: string): Case | null {
  const { loc, gen, dat, from } = config.prepositions;
  if (loc.includes(previous)) return "loc";
  if (gen.includes(previous) || from.includes(previous)) return "gen";
  if (dat.includes(previous)) return "dat";
  return null;
}
