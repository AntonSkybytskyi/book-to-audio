import { nextWord, previousWord, replaceMatches } from "../replace.js";
import type { GenderCase, SlavicConfig } from "./config.js";
import { alternation } from "./context.js";
import type { Case } from "./numerals.js";

const CONSONANT_OR_SOFT_SIGN = /[бвгґджзйклмнпрстфхцчшщь]$/u;
const FOLLOWED_BY_STOP = /^[\s ]*(?:[.,;:!?)»"]|$)/u;

/** Plural endings: the case is the ending's, and a decade is read as one ("1990-х" as "девяностых"). */
function pluralOrdinal(n: number, grammaticalCase: Case, config: SlavicConfig): string | null {
  const { numerals } = config;
  const decade = n >= 10 && n % 10 === 0 && (n < 100 || (n >= 1100 && n <= 2090));
  if (decade) return numerals.decade(n, grammaticalCase);
  // Other four-digit numbers are not ordinals ("1995-х" is nothing).
  return n <= 999 ? numerals.ordinal(n, "p", grammaticalCase) : null;
}

/** "-е" is a neuter ("3-е место"), or a plural for a decade ("в 90-е", "1990-е годы"). */
function neuterOrDecade(n: number, text: string, from: number, to: number, config: SlavicConfig) {
  const { numerals, year, prepositions, suffixes } = config;
  const next = nextWord(text, to);
  if (suffixes.neuterNouns.includes(next)) return numerals.ordinal(n, "n", "nom");
  const decade = n >= 10 && n % 10 === 0 && (n < 100 || (n >= 1100 && n <= 2090));
  if (!decade) return null;
  const previous = previousWord(text, from);
  const preposition = [
    ...prepositions.loc,
    ...prepositions.gen,
    ...prepositions.from,
    ...prepositions.dat,
    "за",
    "в",
  ].includes(previous);
  if (year.pluralWords.includes(next) || (preposition && FOLLOWED_BY_STOP.test(text.slice(to)))) {
    return numerals.decade(n, "nom");
  }
  return null;
}

/** "1960–1970-х": two decades with one ending, both read ("шістдесятих — сімдесятих"). */
function expandDecadeRanges(text: string, config: SlavicConfig): string {
  const { plural } = config.suffixes;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}.,/:-])(\d{2,4})[–—-](\d{2,4})-(${alternation(Object.keys(plural))})(?![\p{L}\p{N}])`,
    "giu",
  );
  return replaceMatches(text, pattern, (m) => {
    const grammaticalCase = plural[(m[3] as string).toLowerCase()];
    const [first, second] = [Number(m[1]), Number(m[2])];
    if (!grammaticalCase || first >= second) return null;
    const start = isDecade(first) ? config.numerals.decade(first, grammaticalCase) : null;
    const end = isDecade(second) ? config.numerals.decade(second, grammaticalCase) : null;
    return start && end && `${start} — ${end}`;
  });
}

const isDecade = (n: number) => n >= 10 && n % 10 === 0 && (n < 100 || (n >= 1100 && n <= 2090));

/** "3-го", "21-й век", "1990-е годы", "20-ті роки": an ordinal written with its ending, where the ending tells the form. */
export function expandOrdinalSuffixes(input: string, config: SlavicConfig): string {
  const text = expandDecadeRanges(input, config);
  const { numerals, suffixes } = config;
  const { endings, short, byPreposition, plural, neuter } = suffixes;
  const alternatives = [
    ...Object.keys(endings),
    ...Object.keys(plural),
    ...neuter,
    short,
    ...(byPreposition ? [byPreposition.ending] : []),
  ];
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}.,/:-])(\d{1,4})-(${alternation([...new Set(alternatives)])})(?![\p{L}\p{N}])`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const n = Number(m[1]);
    const ending = (m[2] as string).toLowerCase();
    const end = m.index + m[0].length;
    const pluralCase = plural[ending];
    if (pluralCase) return pluralOrdinal(n, pluralCase, config);
    if (n > 2999) return null;

    let form: GenderCase | undefined = endings[ending];
    if (neuter.includes(ending) && !form) return neuterOrDecade(n, whole, m.index, end, config);
    if (ending === short) {
      // The short "-й" is a masculine nominative in "21-й век", but also a feminine oblique form
      // ("с 3-й попытки", "у 5-й школі"): the word after it, and the word before, tell which.
      const next = nextWord(whole, end);
      if (CONSONANT_OR_SOFT_SIGN.test(next)) form = { gender: "m", case: "nom" };
      else if (next === "" && suffixes.bareShortIsMasculine) form = { gender: "m", case: "nom" };
      else if (suffixes.feminineLocativeEnding.test(next)) form = { gender: "f", case: "loc" };
      else if (suffixes.feminineGenitiveEnding.test(next)) form = { gender: "f", case: "gen" };
    } else if (byPreposition && ending === byPreposition.ending) {
      const previous = previousWord(whole, m.index);
      const grammaticalCase = byPreposition.loc.includes(previous)
        ? "loc"
        : byPreposition.ins.includes(previous)
          ? "ins"
          : null;
      form = grammaticalCase ? { gender: "m", case: grammaticalCase } : undefined;
    } else if (ending === "ей") {
      // Only "третьей" is written this way.
      form = n % 10 === 3 && n % 100 !== 13 ? form : undefined;
    }
    return form ? numerals.ordinal(n, form.gender, form.case) : null;
  });
}
