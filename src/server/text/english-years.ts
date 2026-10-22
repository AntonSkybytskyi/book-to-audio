import { previousWord, replaceMatches } from "./replace.js";

// espeak-ng reads "1999" as "nineteen hundred ninety nine" and "1066" as "one thousand sixty six",
// and "1990s" as "nineteen hundred ninety s". Years are spelled here, but only where the context
// says it is a year: "1,999 people" and "by 1200 men" are counts, and counts are left to the engine.

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Words after which a four-digit number is a year. */
const BEFORE_YEAR = new Set([
  "in",
  "since",
  "by",
  "from",
  "until",
  "till",
  "during",
  "before",
  "after",
  "around",
  "circa",
  "year",
  "early",
  "late",
  "mid",
  "between",
  ...MONTHS,
]);

/** Words that follow a count or an amount, never a year: "by 1200 men", "in 1500 words". */
const COUNTED = new Set(
  `men women people persons children kids soldiers troops sailors workers students members voters
   employees citizens ships boats cars trucks horses cows sheep animals trees houses homes rooms
   steps words letters lines pages sheets copies books pieces items units points votes names
   dollars pounds euros cents pence francs marks miles feet yards inches meters metres kilometers
   kilometres acres tons tonnes kg km mph lbs oz grams litres liters gallons years days hours
   minutes seconds weeks months times degrees calories shares stocks`
    .split(/\s+/)
    .filter(Boolean),
);

const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 1 to 99 in words. */
function underHundred(n: number): string {
  if (n < 10) return UNITS[n] as string;
  if (n < 20) return TEENS[n - 10] as string;
  const unit = n % 10;
  return unit ? `${TENS[Math.floor(n / 10)]}-${UNITS[unit]}` : (TENS[n / 10] as string);
}

/** A year from 1010 to 1999 as it is said: "nineteen ninety-nine", "nineteen oh five", "ten sixty-six". */
export function spellYear(year: number): string | null {
  if (year < 1010 || year > 1999) return null;
  const century = underHundred(Math.floor(year / 100));
  const rest = year % 100;
  if (rest === 0) return `${century} hundred`;
  return `${century} ${rest < 10 ? `oh ${UNITS[rest]}` : underHundred(rest)}`;
}

const YEAR = String.raw`(1\d{3})`;
const ERA = /^[\s ]*(?:AD|A\.D\.|BC|B\.C\.|BCE|CE)(?![\p{L}])/u;
/** Not inside a longer number or word; a hyphen only after "mid", "early" or "late" ("mid-1800s"). */
const START = String.raw`(?<![\p{L}\p{N}.,$£€])(?:(?<!-)|(?<=\b(?:mid|early|late)-))`;

/** "between 1200 and 1500 dollars": the second number counts, so the first does too. */
const rangeIsCounted = (whole: string, end: number) => {
  const link = /^[\s\u00A0]*(?:and|to|[–-])[\s\u00A0]*\d{3,4}/u.exec(whole.slice(end, end + 20));
  return link !== null && isCounted(whole, end + link[0].length);
};

/** The word after the number says it counts something. */
const isCounted = (whole: string, end: number) => {
  const next = /^[\s ]+(\p{L}+)/u.exec(whole.slice(end, end + 30))?.[1]?.toLowerCase();
  return next !== undefined && COUNTED.has(next);
};

const DATE_BEFORE = new RegExp(String.raw`(?:${MONTHS.join("|")})[\s ]+\d{1,2},?[\s ]+$`, "i");

/** "In 1999" and "June 3, 1999" are years; "1,999 people", "1999 pages" and "by 1200 men" are not. */
function expandSingleYears(text: string): string {
  const pattern = new RegExp(String.raw`${START}${YEAR}(s|'s)?(?![\p{N}]|,\d|\.\d)`, "giu");
  return replaceMatches(text, pattern, (m, whole) => {
    const year = Number(m[1]);
    const end = m.index + m[0].length;
    const before = whole.slice(Math.max(0, m.index - 30), m.index);
    const isYear =
      BEFORE_YEAR.has(previousWord(whole, m.index)) ||
      DATE_BEFORE.test(before) ||
      ERA.test(whole.slice(end)) ||
      (before.endsWith("(") && /^\s*[-–—)]/.test(whole.slice(end))) ||
      m[2] !== undefined;
    if (!isYear || isCounted(whole, end) || rangeIsCounted(whole, end)) return null;
    if (m[2] !== undefined) {
      // 1990s: "nineteen nineties"; 1800s: "eighteen hundreds"
      if (year % 100 !== 0 && year % 10 !== 0) return null;
      if (year % 100 === 0) return `${underHundred(year / 100)} hundreds`;
      const tens = underHundred(year % 100).replace(/y$/, "ie");
      return `${underHundred(Math.floor(year / 100))} ${tens}s`;
    }
    return spellYear(year);
  });
}

/** The end of a range written with two digits ("1914-18"): "eighteen", "oh five". */
const shortYear = (n: number) => (n < 10 ? `oh ${UNITS[n]}` : underHundred(n));

/**
 * Two years that are plainly a range: "1914-1918", "from 1914 to 1918", "between 1914 and 1918",
 * and, where a year is expected ("in", "since", brackets), "1914-18" and "1999-2000".
 */
function expandYearRanges(text: string): string {
  const pattern = new RegExp(
    String.raw`${START}(?:(from|between)[\s ]+)?${YEAR}(?:[\s ]*[–-][\s ]*|[\s ]+(to|and)[\s ]+)(\d{4}|\d{2})(?![\p{N}])`,
    "giu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const start = Number(m[2]);
    const from = spellYear(start);
    const lead = m[1]?.toLowerCase();
    const word = m[3]?.toLowerCase();
    // "and" and "to" only join years after "between" and "from".
    if (word && !(lead === "between" ? word === "and" : lead === "from" && word === "to")) {
      return null;
    }
    const endToken = m[4] as string;
    const end = Number(endToken);
    const after = m.index + m[0].length;
    if (!from || isCounted(whole, after)) return null;
    let spelledEnd: string | null;
    if (endToken.length === 2) {
      // "1914-18" needs a year before it to be a year and not, say, a score.
      const before = whole.slice(Math.max(0, m.index - 30), m.index);
      const context =
        lead !== undefined || BEFORE_YEAR.has(previousWord(whole, m.index)) || before.endsWith("(");
      if (!context || end <= start % 100) return null;
      spelledEnd = shortYear(end);
    } else if (end > start && end <= 1999) {
      spelledEnd = spellYear(end);
    } else {
      // 2000 and later: the engine reads "2000" well.
      spelledEnd = end > start && end <= 2099 ? endToken : null;
    }
    if (!spelledEnd) return null;
    const head = m[1] ? `${m[1]} ` : "";
    return `${head}${from} ${word ?? "to"} ${spelledEnd}`;
  });
}

export const expandEnglishYears = (text: string): string =>
  expandSingleYears(expandYearRanges(text));
