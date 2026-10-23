import { previousWord, replaceMatches } from "../replace.js";
import type { SlavicConfig } from "./config.js";
import { alternation, isYear } from "./context.js";

const isDay = (n: number) => n >= 1 && n <= 31;

/**
 * "12.05.2020": in running text a genitive ("дванадцятого травня дві тисячі двадцятого року"), as
 * a line of its own (a heading, a dateline) the nominative ("дванадцяте травня ...").
 */
function expandNumericDates(text: string, config: SlavicConfig): string {
  const { numerals, months, year } = config;
  return replaceMatches(text, /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d|\.\d)/g, (m, whole) => {
    const [day, month, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isDay(day) || month < 1 || month > 12 || !isYear(y)) return null;
    const alone = whole.trim().replace(/[.!?]$/, "") === m[0];
    const dayWords = numerals.ordinal(day, "n", alone ? "nom" : "gen");
    const yearWords = numerals.ordinal(y, "m", "gen");
    return (
      dayWords && yearWords && `${dayWords} ${months[month - 1]} ${yearWords} ${year.noun.gen}`
    );
  });
}

/**
 * "с 5 по 10 июня": the first day a genitive, the second the accusative after "по" (or the
 * genitive after "до"). Both are expanded, or neither.
 */
function expandFromToDays(text: string, config: SlavicConfig): string {
  const { numerals, months, prepositions } = config;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${alternation(prepositions.from)})[\s ]+(\d{1,2})[\s ]+(по|до)[\s ]+(\d{1,2})(?=[\s ]+(?:${alternation(months)})(?![\p{L}\p{N}]))`,
    "giu",
  );
  return replaceMatches(text, pattern, (m) => {
    const [first, second] = [Number(m[2]), Number(m[4])];
    if (!isDay(first) || !isDay(second) || first >= second) return null;
    const link = (m[3] as string).toLowerCase();
    const start = numerals.ordinal(first, "n", "gen");
    const end = numerals.ordinal(second, "n", link === "по" ? "nom" : "gen");
    return start && end && `${m[1]} ${start} ${m[3]} ${end}`;
  });
}

/** "3 червня": the day is a neuter genitive ordinal. A day in a range with a dash is left to the numbers. */
function expandSingleDays(text: string, config: SlavicConfig): string {
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}.,/:]|\d[–—-])(?<!-)(\d{1,2})(?:-(?:го|ого|е|ое))?(?=[\s ]+(?:${alternation(config.months)})(?![\p{L}\p{N}]))`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const day = Number(m[1]);
    // After "по" the day is an accusative: "по десятое июня".
    const grammaticalCase = previousWord(whole, m.index) === "по" ? "nom" : "gen";
    return isDay(day) ? config.numerals.ordinal(day, "n", grammaticalCase) : null;
  });
}

/** "5–10 червня": both days, as genitives joined by a dash (Ukrainian; Russian leaves the digits). */
function expandDashDays(text: string, config: SlavicConfig): string {
  if (config.code !== "uk") return text;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}.,/:-])(\d{1,2})[–—-](\d{1,2})(?=[\s\u00A0]+(?:${alternation(config.months)})(?![\p{L}\p{N}]))`,
    "giu",
  );
  return replaceMatches(text, pattern, (m) => {
    const [first, second] = [Number(m[1]), Number(m[2])];
    if (!isDay(first) || !isDay(second) || first >= second) return null;
    const start = config.numerals.ordinal(first, "n", "gen");
    const end = config.numerals.ordinal(second, "n", "gen");
    return start && end && `${start} — ${end}`;
  });
}

/**
 * "9 березня 1814": a year straight after a date is a genitive ordinal ("тисяча вісімсот
 * чотирнадцятого"), whether or not "року" follows. A year with its word or abbreviation is left to
 * the year rules, which also write the noun.
 */
function expandYearAfterDate(text: string, config: SlavicConfig): string {
  const { words, abbreviation } = config.year;
  const pattern = new RegExp(
    String.raw`(${alternation(config.months)})([\s\u00A0]+)(\d{4})(?![\p{N}])(?![\s\u00A0]+(?:${alternation(Object.keys(words))})(?![\p{L}\p{N}])|[\s\u00A0]+${abbreviation}\.|[\s\u00A0]*[–—-]\d{4}[\s\u00A0]+(?:${config.year.pluralAbbreviation})\.)`,
    "giu",
  );
  return replaceMatches(text, pattern, (m) => {
    const y = Number(m[3]);
    const ordinal = isYear(y) ? config.numerals.ordinal(y, "m", "gen") : null;
    return ordinal && `${m[1]}${m[2]}${ordinal}`;
  });
}

export const expandDates = (text: string, config: SlavicConfig): string =>
  expandYearAfterDate(
    expandSingleDays(
      expandDashDays(expandFromToDays(expandNumericDates(text, config), config), config),
      config,
    ),
    config,
  );
