import { previousWord, replaceMatches } from "../replace.js";
import { parseRoman } from "../roman.js";
import type { SlavicConfig } from "./config.js";
import { alternation, dotIfSentenceEnds } from "./context.js";

/** Roman numerals for centuries: I, V, X (also the Cyrillic І and Х) up to XXX. */
const CENTURY = "[IVXІХ]+";
const MAX_CENTURY = 30;

const century = (token: string): number | null => {
  const value = parseRoman(token, true);
  return value !== null && value <= MAX_CENTURY ? value : null;
};

/** "XVIII–XIX веках", "XIX–XX ст.": both ends, in the case the noun or the word before asks for. */
function expandCenturyRanges(text: string, config: SlavicConfig): string {
  const { rangeWords, abbreviation, pluralAbbreviation, rangeNoun, gender, caseAfter } =
    config.century;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${CENTURY})[–—-](${CENTURY})[\s ]+(?:(${alternation(Object.keys(rangeWords))})(?![\p{L}\p{N}])|(?:${alternation([abbreviation, pluralAbbreviation])})\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const [from, to] = [century(m[1] as string), century(m[2] as string)];
    if (from === null || to === null || from >= to) return null;
    const word = m[3]?.toLowerCase();
    const written = word ? rangeWords[word] : undefined;
    const previous = previousWord(whole, m.index);
    // An ambiguous form ("століття", "века") is a nominative or a genitive, as the word before says.
    const grammaticalCase = written && written !== "amb" ? written : caseAfter(previous);
    if (grammaticalCase !== "nom" && grammaticalCase !== "gen" && grammaticalCase !== "loc") {
      return null;
    }
    const start = config.numerals.ordinal(from, gender, grammaticalCase);
    const end = config.numerals.ordinal(to, gender, grammaticalCase);
    if (!start || !end) return null;
    const tail = written && written !== "amb" ? (m[3] as string) : rangeNoun[grammaticalCase];
    const dot = word ? "" : dotIfSentenceEnds(whole, m.index + m[0].length);
    return `${start} — ${end} ${tail}${dot}`;
  });
}

/** "XIX століття", "в XX в.": a Roman numeral and a word for a century. */
function expandRomanCenturies(text: string, config: SlavicConfig): string {
  const { words, abbreviation, noun, gender, caseAfter } = config.century;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${CENTURY})(?:-(?:го|й|м|му|е|ом|ий|ого))?[\s ]+(?:(${alternation(Object.keys(words))})(?![\p{L}\p{N}])|${abbreviation}\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const value = century(m[1] as string);
    if (value === null) return null;
    const word = m[2]?.toLowerCase();
    const form = word ? words[word] : undefined;
    const previous = previousWord(whole, m.index);
    const grammaticalCase = form && form !== "amb" ? form : caseAfter(previous);
    const ordinal = config.numerals.ordinal(value, gender, grammaticalCase);
    if (!ordinal) return null;
    const tail = word ? (m[2] as string) : noun[grammaticalCase];
    const after = word ? "" : dotIfSentenceEnds(whole, m.index + m[0].length);
    return `${ordinal} ${tail}${after}`;
  });
}

/**
 * "у 21 столітті", "до 21 століття": the number written with digits before a written century
 * word. "3 століття" can also be a count (three centuries), so a nominative or a genitive is only
 * read as an ordinal when nothing but an ordinal fits: after a genitive preposition, or when the
 * number is not one a plural noun could follow.
 */
function expandDigitCenturies(text: string, config: SlavicConfig): string {
  const { words, gender, caseAfter } = config.century;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}.,/:-])(\d{1,2})(?:-(?:го|й|м|му|е|ом|ий|ого))?[\s\u00A0]+(${alternation(Object.keys(words))})(?![\p{L}\p{N}])`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const value = Number(m[1]);
    if (value < 1 || value > MAX_CENTURY) return null;
    const form = words[(m[2] as string).toLowerCase()];
    const byWord = form && form !== "amb" ? form : null;
    const byContext = caseAfter(previousWord(whole, m.index));
    let grammaticalCase = byWord ?? (byContext === "gen" ? "gen" : "nom");
    if (byWord === "gen" && byContext !== "gen") return null; // "через 3 века" is a count
    if (grammaticalCase === "nom") {
      // 2 to 4 (and 22 to 24 ...) take a singular count: "три века". Five or more take "веков".
      const countable = value % 10 >= 2 && value % 10 <= 4 && (value < 10 || value > 14);
      if (value < 5 || countable) return null;
    }
    if (grammaticalCase === "acc") grammaticalCase = "nom";
    const ordinal = config.numerals.ordinal(value, gender, grammaticalCase);
    return ordinal && `${ordinal} ${m[2]}`;
  });
}

export const expandCenturies = (text: string, config: SlavicConfig): string =>
  expandDigitCenturies(expandRomanCenturies(expandCenturyRanges(text, config), config), config);
