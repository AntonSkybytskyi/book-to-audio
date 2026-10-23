import { previousWord, replaceMatches } from "../replace.js";
import type { Currency, SlavicConfig } from "./config.js";
import { dotIfSentenceEnds, NOT_IN_NUMBER } from "./context.js";
import type { Gender } from "./numerals.js";

const MAX_DIGITS = 12;

/**
 * Whether the number after `previous` is a genitive: after "до", "від", "після" ... which only take
 * one, or after "з" / "с" when it opens a "з 3 до 5" range.
 */
export function isGenitiveContext(config: SlavicConfig, whole: string, index: number, end: number) {
  const previous = previousWord(whole, index);
  const { gen, from } = config.prepositions;
  if (gen.includes(previous)) return true;
  return from.includes(previous) && /^[\s ]*(?:до|по)[\s ]+\d/u.test(whole.slice(end));
}

/**
 * A number as the text should have it. Ukrainian spells it, in the genitive where that is the case.
 * Russian leaves digits to the engine, except 1 and 2 before a feminine or neuter noun, which the
 * engine reads as masculine ("одна копейка"); a genitive stays digits.
 */
export function spellNumber(
  n: number,
  config: SlavicConfig,
  genitive: boolean,
  gender: Gender = "m",
): string {
  const { numerals } = config;
  if (numerals.cardinalGenitive) {
    return genitive ? numerals.cardinalGenitive(n, gender) : numerals.cardinal(n, gender);
  }
  const needsGender =
    gender !== "m" && !genitive && [1, 2].includes(n % 10) && n % 100 !== 11 && n % 100 !== 12;
  return needsGender ? numerals.cardinal(n, gender) : String(n);
}

/** The noun after a number: nominative count forms, or the genitive (singular after a 1). */
export function countedNoun(
  n: number,
  config: SlavicConfig,
  forms: readonly [string, string, string],
  genitiveForms: readonly [string, string],
  genitive: boolean,
): string {
  if (!genitive) return config.numerals.plural(n, forms);
  return n % 10 === 1 && n % 100 !== 11 ? genitiveForms[0] : genitiveForms[1];
}

/** "3,5" as words: "три цілих п'ять десятих". Null for more than three decimals. */
export function spellDecimal(
  whole: string,
  fraction: string,
  config: SlavicConfig,
  genitive = false,
): string | null {
  if (whole.length > MAX_DIGITS || fraction.length > 3) return null;
  const { numerals, decimal } = config;
  const wholeNumber = Number(whole);
  const fractionNumber = Number(fraction);
  const denominators = decimal.fractions[fraction.length - 1] as (typeof decimal.fractions)[number];
  if (genitive && !numerals.cardinalGenitive) return null;
  const parts = genitive
    ? [
        (numerals.cardinalGenitive as NonNullable<typeof numerals.cardinalGenitive>)(
          wholeNumber,
          "f",
        ),
        wholeNumber % 10 === 1 && wholeNumber % 100 !== 11
          ? decimal.wholeGenitive[0]
          : decimal.wholeGenitive[1],
        (numerals.cardinalGenitive as NonNullable<typeof numerals.cardinalGenitive>)(
          fractionNumber,
          "f",
        ),
        (decimal.fractionsGenitive[fraction.length - 1] as readonly [string, string])[
          fractionNumber % 10 === 1 && fractionNumber % 100 !== 11 ? 0 : 1
        ],
      ]
    : [
        numerals.cardinal(wholeNumber, "f"),
        numerals.plural(wholeNumber, decimal.whole),
        numerals.cardinal(fractionNumber, "f"),
        numerals.plural(fractionNumber, denominators),
      ];
  return parts.join(" ");
}

/** What Russian leaves to the engine: "3,5" stays as digits, with the noun in its form. */
const decimalText = (whole: string, fraction: string, config: SlavicConfig, genitive: boolean) =>
  config.numerals.cardinalGenitive
    ? spellDecimal(whole, fraction, config, genitive)
    : `${whole},${fraction}`;

/**
 * "15%", "3,5%", "10-15%": the number and "відсотків / процентов" in the form the number asks for.
 * After "до", "від", "після" and the like the number is a genitive.
 */
export function expandPercent(text: string, config: SlavicConfig): string {
  const { percent } = config;
  const pattern = new RegExp(
    String.raw`${NOT_IN_NUMBER}(\d{1,${MAX_DIGITS}})(?:[–—-](\d{1,${MAX_DIGITS}}))?(?:([,.])(\d{1,3}))?[\s ]*%`,
    "gu",
  );
  return replaceMatches(text, pattern, (m, whole) => {
    const genitive = isGenitiveContext(config, whole, m.index, m.index + m[0].length);
    const [first, last] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (m[4] !== undefined) {
      if (m[2] !== undefined) return null; // "5-6,5%" is not worth guessing
      const decimal = decimalText(m[1] as string, m[4], config, genitive);
      return decimal && `${decimal} ${percent.genitive[0]}`;
    }
    const noun = countedNoun(last, config, percent.forms, percent.genitive, genitive);
    const spelled = spellNumber(first, config, genitive);
    return m[2] === undefined
      ? `${spelled} ${noun}`
      : `${spelled} — ${spellNumber(last, config, genitive)} ${noun}`;
  });
}

function spellMoney(
  whole: string,
  cents: string | undefined,
  currency: Currency,
  config: SlavicConfig,
  genitive: boolean,
): string | null {
  const n = Number(whole);
  const major = `${spellNumber(n, config, genitive, currency.gender)} ${countedNoun(n, config, currency.forms, currency.genitive, genitive)}`;
  const hasCents = cents !== undefined && Number(cents) > 0;
  if (!hasCents) return major;
  if (!currency.minor) return null;
  // "1,5 грн" is one hryvnia and fifty kopecks: one digit is tens.
  const c = cents.length === 1 ? Number(cents) * 10 : Number(cents);
  const { minor } = currency;
  return `${major} ${spellNumber(c, config, genitive, minor.gender)} ${countedNoun(c, config, minor.forms, minor.genitive, genitive)}`;
}

const escape = (name: string) => name.replace(/[$.]/g, String.raw`\$&`);

/** "$5", "5 €", "12,50 грн.", "7 руб.", "10-20 грн": the amount and the currency in the form it asks for. */
export function expandCurrency(text: string, config: SlavicConfig): string {
  const names = Object.keys(config.currencies).toSorted((a, b) => b.length - a.length);
  const symbols = names.filter((name) => /^[$€£]$/.test(name)).map(escape);
  const words = names.filter((name) => !/^[$€£]$/.test(name)).map(escape);
  // Not the start of "1,200" or "5.5.2020": the number must end where the amount ends.
  const number = String.raw`(\d{1,${MAX_DIGITS}})(?:[,.](\d{1,2}))?(?![\d]|[,.]\d)`;
  const lookup = (key: string) => config.currencies[key.toLowerCase()];

  const written = new RegExp(
    String.raw`${NOT_IN_NUMBER}(\d{1,${MAX_DIGITS}})[–—-]${number}[\s ]*(${[...symbols, ...words].join("|")})(\.)?(?![\p{L}\p{N}])|${NOT_IN_NUMBER}${number}[\s ]*(${[...symbols, ...words].join("|")})(\.)?(?![\p{L}\p{N}])`,
    "giu",
  );
  const first = new RegExp(String.raw`(${symbols.join("|")})[\s ]?${number}`, "gu");

  const afterAmount = replaceMatches(text, written, (m, whole) => {
    const range = m[1] !== undefined;
    const [start, whole2, cents, name, dot] = range
      ? [m[1], m[2], m[3], m[4], m[5]]
      : [undefined, m[6], m[7], m[8], m[9]];
    const currency = lookup(name as string);
    if (!currency) return null;
    const genitive = isGenitiveContext(config, whole, m.index, m.index + m[0].length);
    const spelled = spellMoney(whole2 as string, cents, currency, config, genitive);
    if (!spelled) return null;
    const head =
      start === undefined
        ? ""
        : `${spellNumber(Number(start), config, genitive, currency.gender)} — `;
    // A dot that belonged to the abbreviation also ended the sentence when a capital follows.
    return head + spelled + (dot ? dotIfSentenceEnds(whole, m.index + m[0].length) : "");
  });
  return replaceMatches(afterAmount, first, (m, whole) => {
    const currency = lookup(m[1] as string);
    const genitive = isGenitiveContext(config, whole, m.index, m.index + m[0].length);
    return (currency && spellMoney(m[2] as string, m[3], currency, config, genitive)) || null;
  });
}

/** "10:30" as "десять тридцять"; "9:05" as "дев'ять нуль п'ять". */
export function expandTimes(text: string, config: SlavicConfig): string {
  const zero = config.numerals.cardinal(0);
  return replaceMatches(text, /(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (m) => {
    const hours = config.numerals.cardinal(Number(m[1]));
    const minutes = Number(m[2]);
    if (minutes === 0) return `${hours} ${zero} ${zero}`;
    return `${hours} ${minutes < 10 ? `${zero} ` : ""}${config.numerals.cardinal(minutes)}`;
  });
}

/** "о 5 годині", "об 11 годині" (Ukrainian): the hour is a feminine locative ordinal. */
export function expandHourLocative(text: string, config: SlavicConfig): string {
  const pattern =
    /(?<![\p{L}\p{N}])(о|об)([\s ]+)(\d{1,2})(?:-й)?([\s ]+годині)(?![\p{L}\p{N}])/giu;
  return replaceMatches(text, pattern, (m) => {
    const hour = Number(m[3]);
    const ordinal = hour >= 1 && hour <= 24 ? config.numerals.ordinal(hour, "f", "loc") : null;
    return ordinal && `${m[1]}${m[2]}${ordinal}${m[4]}`;
  });
}
