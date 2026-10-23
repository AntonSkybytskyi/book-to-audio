import { replaceMatches } from "./replace.js";
import { headingNumeral, parseRoman, plainNumeral } from "./roman.js";

// espeak-ng reads a Roman numeral as "roman four" ("Chapter IV"). The numeral is turned into
// digits, which it reads well ("Chapter 4"). It is only done where a numeral is expected.

/** Headings that are numbered: a numeral of I, V, X, L, C up to 150 follows. */
const CHAPTER_WORDS = [
  "chapter",
  "part",
  "book",
  "volume",
  "vol\\.",
  "act",
  "scene",
  "canto",
  "war",
  "psalm",
  "stanza",
];
/** Headings that are often lettered ("Appendix C", "Section D"): only a numeral of two or more letters is read. */
const LABEL_WORDS = ["section", "appendix", "article", "plate", "table", "figure", "exhibit"];

const REGNAL_NAMES = [
  "Henry",
  "Edward",
  "George",
  "Louis",
  "Charles",
  "Richard",
  "William",
  "James",
  "John",
  "Philip",
  "Elizabeth",
  "Victoria",
  "Mary",
  "Anne",
  "Pius",
  "Paul",
  "Peter",
  "Alexander",
  "Nicholas",
  "Napoleon",
  "Frederick",
  "Ferdinand",
  "Leopold",
  "Innocent",
  "Gregory",
  "Benedict",
  "Leo",
  "Clement",
  "Urban",
];

const ordinalSuffix = (n: number) => {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
};

/** "Part I", "World War I": a lone numeral after a capitalised word, or one that ends a phrase. */
const isLoneNumeralSafe = (keyword: string, after: string) =>
  /^\p{Lu}/u.test(keyword) || /^\s*([.,;:)]|$)/u.test(after) || /^\s+of\b/.test(after);

/** "Chapter IV", "World War II", "Henry VIII": espeak would say "roman four". */
function expandKeywordNumerals(text: string): string {
  const keyword = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${[...CHAPTER_WORDS, ...LABEL_WORDS].join("|")})([\s ]+)([IVXLCDM]{1,12})(?![\p{L}\p{N}])`,
    "giu",
  );
  return replaceMatches(text, keyword, (m, whole) => {
    const word = (m[1] as string).toLowerCase().replace(/\.$/, "");
    const token = m[3] as string;
    const label = LABEL_WORDS.includes(word);
    const value = label ? plainNumeral(token) : headingNumeral(token);
    if (value === null) return null;
    if (
      token.length === 1 &&
      !isLoneNumeralSafe(m[1] as string, whole.slice(m.index + m[0].length))
    ) {
      return null;
    }
    return `${m[1]}${m[2]}${value}`;
  });
}

/** "Henry VIII" as "Henry the 8th": regnal names from a fixed list. */
function expandRegnal(text: string): string {
  const regnal = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${REGNAL_NAMES.join("|")})([\s ]+)([IVX]+)(?![\p{L}\p{N}])(?=\s*[.,;:)]|\s*$|'s|\s+\p{Ll})`,
    "gu",
  );
  return replaceMatches(text, regnal, (m, whole) => {
    const value = parseRoman(m[3] as string);
    if (value === null || value > 39) return null;
    const after = whole.slice(m.index + m[0].length);
    // "Mary V. Smith": a single letter and a stop before a capital is an initial.
    if ((m[3] as string).length === 1 && /^\.\s+\p{Lu}/u.test(after)) return null;
    // A lone "I" is the pronoun unless a sentence ends right there.
    if (value === 1 && !/^\s*([.,;:)]|$)/.test(after)) return null;
    return `${m[1]} the ${value}${ordinalSuffix(value)}`;
  });
}

/** A paragraph that is only a numeral ("IV", "XII.") is a chapter heading. */
function expandBareNumeral(text: string): string {
  return text.replace(/^(\s*)([IVXLCDM]{1,12})(\.?\s*)$/, (all, a, token: string, b) => {
    const value = headingNumeral(token);
    return value === null ? all : `${a}${value}${b}`;
  });
}

export const expandEnglishNumerals = (text: string): string =>
  expandRegnal(expandKeywordNumerals(expandBareNumeral(text)));
