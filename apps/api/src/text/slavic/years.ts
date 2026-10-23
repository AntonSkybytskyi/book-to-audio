import { previousWord, replaceMatches } from "../replace.js";
import type { SlavicConfig } from "./config.js";
import {
  alternation,
  caseAfterPreposition,
  dotIfSentenceEnds,
  isYear,
  NOT_IN_NUMBER,
} from "./context.js";

/**
 * "с 1914 по 1918 год": both ends are expanded, the first as a genitive and the second as the
 * accusative after "по" or the genitive after "до". Returns text unchanged where the shape differs.
 */
function expandFromToYears(text: string, config: SlavicConfig): string {
  const { words, abbreviation, pluralAbbreviation, noun } = config.year;
  const { numerals } = config;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${alternation(config.prepositions.from)})([\s ]+)(\d{4})[\s ]+(по|до)[\s ]+(\d{4})[\s ]+(?:(${alternation(Object.keys(words))})(?![\p{L}\p{N}])|(?:${abbreviation}|${pluralAbbreviation})\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const [from, to] = [Number(m[3]), Number(m[5])];
    if (!isYear(from) || !isYear(to) || from >= to) return null;
    const link = (m[4] as string).toLowerCase();
    const start = numerals.ordinal(from, "m", "gen");
    const end = numerals.ordinal(to, "m", link === "по" ? "nom" : "gen");
    if (!start || !end) return null;
    const endNoun = link === "по" ? noun.nom : noun.gen;
    const dot = m[6] ? "" : dotIfSentenceEnds(whole, m.index + m[0].length);
    return `${m[1]} ${start} ${noun.gen} ${m[4]} ${end} ${endNoun}${dot}`;
  });
}

/** "в 1914–1918 гг.", "в 1914–1918 годах": both ends in the case of the plural word. */
function expandYearRanges(text: string, config: SlavicConfig): string {
  const { pluralAbbreviation, rangeNouns } = config.year;
  const { numerals } = config;
  const pattern = new RegExp(
    String.raw`${NOT_IN_NUMBER}(\d{4})[–—-](\d{4})[\s ]+(?:(${alternation(Object.values(rangeNouns))})(?![\p{L}\p{N}])|${pluralAbbreviation}\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (!isYear(from) || !isYear(to) || from >= to) return null;
    const word = m[3]?.toLowerCase();
    let grammaticalCase = word
      ? word === rangeNouns.loc
        ? "loc"
        : "gen"
      : caseAfterPreposition(config, previousWord(whole, m.index));
    // "1914–1918 рр." with nothing before it: "роки" where the language has the nominative.
    if (!grammaticalCase && !word && rangeNouns.nom) grammaticalCase = "nom";
    if (grammaticalCase !== "loc" && grammaticalCase !== "gen" && grammaticalCase !== "nom") {
      return null;
    }
    const start = numerals.ordinal(from, "m", grammaticalCase);
    const end = numerals.ordinal(to, "m", grammaticalCase);
    if (!start || !end) return null;
    const tail = word ? (m[3] as string) : (rangeNouns[grammaticalCase] as string);
    const dot = word ? "" : dotIfSentenceEnds(whole, m.index + m[0].length);
    return `${start} — ${end} ${tail}${dot}`;
  });
}

/** "(1814–1861)": two years in brackets, read as the years of a life (Ukrainian only). */
function expandBracketedYears(text: string, config: SlavicConfig): string {
  return replaceMatches(text, /\((\d{4})[–—-](\d{4})\)/g, (m) => {
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (!isYear(from) || !isYear(to) || from >= to) return null;
    const start = config.numerals.ordinal(from, "m", "nom");
    const end = config.numerals.ordinal(to, "m", "nom");
    return start && end ? `(${start} — ${end})` : null;
  });
}

/** "1999 году" and "1999 г." become the ordinal in the case the word asks for. */
function expandSingleYears(text: string, config: SlavicConfig): string {
  const { words, abbreviation, noun, abbreviationCase, refine } = config.year;
  const pattern = new RegExp(
    String.raw`${NOT_IN_NUMBER}(\d{4})[\s ]+(?:(${alternation(Object.keys(words))})(?![\p{L}\p{N}])|${abbreviation}\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const year = Number(m[1]);
    if (!isYear(year)) return null;
    const word = m[2]?.toLowerCase();
    const previous = previousWord(whole, m.index);
    const written = word ? words[word] : undefined;
    const grammaticalCase = written
      ? (refine?.(written, previous) ?? written)
      : abbreviationCase(previous);
    if (!grammaticalCase) return null;
    const ordinal = config.numerals.ordinal(year, "m", grammaticalCase);
    if (!ordinal) return null;
    const tail = word ? (m[2] as string) : noun[grammaticalCase];
    const after = word ? "" : dotIfSentenceEnds(whole, m.index + m[0].length);
    return `${ordinal} ${tail}${after}`;
  });
}

export function expandYears(text: string, config: SlavicConfig): string {
  let result = expandFromToYears(text, config);
  result = expandYearRanges(result, config);
  if (config.code === "uk") result = expandBracketedYears(result, config);
  return expandSingleYears(result, config);
}
