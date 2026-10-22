import { nextWord, previousWord, replaceMatches } from "./replace.js";
import { agreementAfterLabel, agreementBefore, spellAgreeing } from "./slavic/agreement.js";
import { isGenitiveContext, spellDecimal } from "./slavic/amounts.js";
import { nounsUk } from "./slavic/guess-uk.js";
import { ukrainian } from "./ukrainian-config.js";

// The Ukrainian voice has no digits in its alphabet: what the rules before could not place is
// spelled here. A number is a plain nominative cardinal unless the word before it asks for the
// genitive ("до 5 років" is "до п'яти років"); that is the only case it can tell for sure.

const { numerals } = ukrainian;
const MAX_SPELLED_DIGITS = 12;
/** Longer runs of digits are not numbers anybody reads; they are dropped. */
const MAX_DIGIT_RUN = 30;

const spellDigits = (digits: string) =>
  [...digits].map((d) => numerals.cardinal(Number(d))).join(" ");

/** The padded words of a number: a number glued to a letter ("A4") must not glue its words to it. */
const GLUING = /[\p{L}×÷*/\\|&+=<>^~_#@]/u;
const padded = (words: string, whole: string, start: number, end: number) => {
  const before = GLUING.test(whole.charAt(start - 1)) ? " " : "";
  const after = GLUING.test(whole.charAt(end)) ? " " : "";
  return `${before}${words}${after}`;
};

/**
 * Digits glued to the end of a Ukrainian word are the marker of a note ("слово1", "пішов.2"), which
 * nobody reads aloud.
 */
export function dropNoteMarkers(text: string): string {
  return text
    .replace(/(?<=\p{Script=Cyrillic}{4})\d{1,3}(?![\d\p{L}])/gu, "")
    .replace(/(?<=\p{Script=Cyrillic}{4}[.,;:!?»”)])\d{1,3}(?=[\s ]+\p{Lu}|[\s ]*$)/gu, "");
}

/**
 * "3/4" as "три четвертих", "1/2" as "одна друга": the numerator as a feminine cardinal, the
 * denominator as a feminine ordinal (after 1) or a genitive plural. Not a fraction (a date, a
 * score, a numerator that is not smaller): the slash is a pause.
 */
function spellFractions(text: string): string {
  const pattern = /(?<![\p{L}\p{N}.,/:-])(\d{1,2})\/(\d{1,2})(?![\p{N}/:])/gu;
  return replaceMatches(text, pattern, (m) => {
    const [top, bottom] = [Number(m[1]), Number(m[2])];
    if (top < 1 || bottom < 2 || top >= bottom) return null;
    const one = top % 10 === 1 && top % 100 !== 11;
    const denominator = one
      ? numerals.ordinal(bottom, "f", "nom")
      : numerals.ordinal(bottom, "p", "gen");
    return denominator && `${numerals.cardinal(top, "f")} ${denominator}`;
  });
}

const phoneGroups = (number: string) => number.split("-").map(spellDigits).join(" — ");

/** "555-1234" and "067-123-45-67": phone numbers are read digit by digit, a pause between the groups. */
function spellPhoneNumbers(text: string): string {
  return text
    .replace(/(?<![\d-])\d{2,4}(?:-\d{2,4}){2,4}(?![\d-])/g, phoneGroups)
    .replace(/(?<![\d-])\d{3}-\d{4}(?![\d-])/g, phoneGroups);
}

/** All digits left in the text as words: decimals, "5.2", dashes between numbers, plain numbers. */
export function spellRemainingNumbers(text: string): string {
  let result = text.replace(new RegExp(String.raw`\d{${MAX_DIGIT_RUN + 1},}`, "g"), "");
  result = dropNoteMarkers(result);
  result = spellFractions(result);
  result = spellPhoneNumbers(result);
  // "2×2" is "два на два"; another slash between numbers is a pause.
  result = result.replace(/(?<=\d)\s?×\s?(?=\d)/g, " на ").replace(/(?<=\d)\/(?=\d)/g, ", ");
  result = replaceMatches(result, /(?<![\d,])(\d{1,12}),(\d{1,3})(?!\d|,\d)/g, (m, whole) =>
    spellDecimal(
      m[1] as string,
      m[2] as string,
      ukrainian,
      isGenitiveContext(ukrainian, whole, m.index, m.index + m[0].length),
    ),
  );
  result = result.replace(
    /(?<![\d.])(\d{1,12})\.(\d{1,12})(?!\d|\.\d)/g,
    (_, a: string, b: string) => `${spellInteger(a)} крапка ${spellInteger(b)}`,
  );
  // "5–10" is not a minus: a dash with room around it.
  result = result.replace(/(?<=\d)[–—-](?=\d)/g, " — ");
  result = result.replace(/(?<![\p{L}\p{N}])[-−](?=\d)/gu, "мінус ");
  // The ending of "5-й" that no rule could place has nothing to attach to once the number is a word.
  result = result.replace(/(?<!\d)(\d{1,12})-\p{Ll}{1,4}(?![\p{L}])/gu, "$1");
  return replaceMatches(result, /\d+/g, (m, whole) => {
    const end = m.index + m[0].length;
    const digits = m[0];
    let words: string;
    if (digits.length > MAX_SPELLED_DIGITS || (digits.length > 1 && digits.startsWith("0"))) {
      words = spellDigits(digits);
    } else {
      const n = Number(digits);
      const next = nextWord(whole, end);
      const agreement =
        (next ? agreementBefore(n, next, nounsUk) : null) ??
        agreementAfterLabel(n, previousWord(whole, m.index), nounsUk);
      if (isGenitiveContext(ukrainian, whole, m.index, end)) {
        words = numerals.cardinalGenitive?.(n, agreement?.gender ?? "m") ?? numerals.cardinal(n);
      } else {
        words = agreement ? spellAgreeing(n, agreement, numerals) : numerals.cardinal(n);
      }
    }
    return padded(words, whole, m.index, end);
  });
}

const spellInteger = (digits: string) =>
  digits.length > MAX_SPELLED_DIGITS || (digits.length > 1 && digits.startsWith("0"))
    ? spellDigits(digits)
    : numerals.cardinal(Number(digits));
