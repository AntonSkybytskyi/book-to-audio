import { replaceMatches } from "../replace.js";
import type { Gender, Numerals } from "./numerals.js";

/**
 * Nouns that tell the gender of a number ending in 1 or 2: "одна книга", "одне яблуко", "дві
 * книги", "одну книгу". Only words in these lists (and, for Ukrainian, a few endings that only
 * nouns have) change anything: a guess from any ending would also catch label nouns, verbs and
 * adjectives ("в 21 веке", "глава 1"), so the default masculine stays for every other word.
 */
export interface NounLists {
  /** Feminine nouns in the nominative singular (after 1). */
  feminine: ReadonlySet<string>;
  /** Neuter nouns in the nominative singular (after 1). */
  neuter: ReadonlySet<string>;
  /** Feminine nouns in the nominative plural, which follow 2 and look like masculine ones. */
  femininePlural: ReadonlySet<string>;
  /** Endings that only a noun of that gender has, for words not in the lists (after 1). */
  endings?: { feminine: RegExp; neuter: RegExp };
}

/** Builds the lists from "singular/plural" pairs of feminine nouns and plain neuter nouns. */
export function nounLists(
  feminine: string,
  neuter: string,
  endings?: NounLists["endings"],
): NounLists {
  const pairs = feminine
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split("/"));
  return {
    feminine: new Set(pairs.map(([singular]) => singular as string)),
    femininePlural: new Set(pairs.map(([, plural]) => plural as string)),
    neuter: new Set(neuter.split(/\s+/).filter(Boolean)),
    ...(endings ? { endings } : {}),
  };
}

/** The gender a number is spelled in, and whether the noun is an accusative ("одну книгу"). */
export interface Agreement {
  gender: Gender;
  accusative: boolean;
}

/** Letters, then not a digit: the word right after a number. */
const NUMBER_BEFORE_WORD =
  /(?<![\p{L}\p{N}.,:/-])(\d{1,12})(?![\d]|[.,:/]\d)(?=[\s\u00A0]+(\p{L}+))/gu;

/** "книгу" is the accusative of the feminine "книга": the nominative candidate, or null. */
const nominativeOfAccusative = (word: string) =>
  /[ую]$/u.test(word) ? word.slice(0, -1) + (word.endsWith("у") ? "а" : "я") : null;

/** The agreement of `n` with the word after it, when it is not the default masculine. */
export function agreementBefore(n: number, next: string, lists: NounLists): Agreement | null {
  const word = next.toLowerCase();
  if (n % 10 === 1 && n % 100 !== 11) {
    if (lists.feminine.has(word)) return { gender: "f", accusative: false };
    if (lists.neuter.has(word)) return { gender: "n", accusative: false };
    const nominative = nominativeOfAccusative(word);
    if (nominative && lists.feminine.has(nominative)) return { gender: "f", accusative: true };
    if (lists.endings?.neuter.test(word)) return { gender: "n", accusative: false };
    if (lists.endings?.feminine.test(word)) return { gender: "f", accusative: false };
    return null;
  }
  if (n % 10 === 2 && n % 100 !== 12 && lists.femininePlural.has(word)) {
    return { gender: "f", accusative: false };
  }
  return null;
}

/** "стаття 1", "сторінка 2": a number after a feminine label noun agrees with it. */
export function agreementAfterLabel(
  n: number,
  previous: string,
  lists: NounLists,
): Agreement | null {
  const last = n % 10;
  const small = (last === 1 && n % 100 !== 11) || (last === 2 && n % 100 !== 12);
  return small && lists.feminine.has(previous) ? { gender: "f", accusative: false } : null;
}

/** The cardinal in the agreement's gender: "одна" before "книга", "одну" before "книгу". */
export function spellAgreeing(n: number, agreement: Agreement, numerals: Numerals): string {
  const words = numerals.cardinal(n, agreement.gender);
  return agreement.accusative ? words.replace(/одна$/u, "одну") : words;
}

/**
 * Spells the numbers that need a feminine or neuter form ("21 яблоко" as "двадцать одно яблоко"),
 * leaving every other number as digits.
 */
export function spellAgreeingNumbers(text: string, numerals: Numerals, lists: NounLists): string {
  return replaceMatches(text, NUMBER_BEFORE_WORD, (m) => {
    const n = Number(m[1]);
    const agreement = agreementBefore(n, m[2] as string, lists);
    return agreement && spellAgreeing(n, agreement, numerals);
  });
}
