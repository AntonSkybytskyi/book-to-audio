import { expandAbbreviations, type AbbreviationRule } from "./abbreviations.js";
import { expandEnglishNumerals } from "./english-roman.js";
import { expandEnglishYears } from "./english-years.js";

export { spellYear } from "./english-years.js";

// What espeak-ng (Piper's phonemizer) gets wrong for English, found in docs/decisions/text-processing.md:
// years such as 1999 ("nineteen hundred ninety nine"), Roman numerals ("roman four") and a few
// abbreviations it spells out ("Jr." as "J R"). Everything else it reads well and is left alone.

const titles = (abbreviation: string, words: string): AbbreviationRule => ({
  pattern: String.raw`${abbreviation}\.`,
  words,
  beforeCapital: true,
});
const afterName = (abbreviation: string, words: string): AbbreviationRule => ({
  pattern: String.raw`${abbreviation}\.`,
  words,
  afterCapitalWord: true,
  mayEndSentence: true,
});

/** The abbreviations espeak spells out letter by letter or reads as a word. */
const ABBREVIATIONS: readonly AbbreviationRule[] = [
  afterName("Jr", "Junior"),
  afterName("Sr", "Senior"),
  afterName("Inc", "Incorporated"),
  afterName("Corp", "Corporation"),
  afterName("Co", "Company"),
  titles("Mt", "Mount"),
  titles("Lt", "Lieutenant"),
  titles("Col", "Colonel"),
  titles("Sgt", "Sergeant"),
  titles("Capt", "Captain"),
  titles("Gen", "General"),
  titles("Adm", "Admiral"),
  titles("Maj", "Major"),
  titles("Cmdr", "Commander"),
  titles("Gov", "Governor"),
  titles("Sen", "Senator"),
  titles("Rev", "Reverend"),
  titles("Prof", "Professor"),
  titles("Pres", "President"),
  titles("Supt", "Superintendent"),
  titles("Mme", "Madame"),
  titles("Ms", "Miz"),
  titles("Sts", "Saints"),
  { pattern: String.raw`Ph\.D\.`, words: "P H D", mayEndSentence: true },
  { pattern: String.raw`vs\.`, words: "versus", ignoreCase: true },
  { pattern: String.raw`cf\.`, words: "compare" },
  { pattern: String.raw`ca\.`, words: "circa", beforeNumber: true },
  { pattern: String.raw`ch\.`, words: "chapter", beforeNumber: true, ignoreCase: true },
  { pattern: String.raw`pp\.`, words: "pages", beforeNumber: true, ignoreCase: true },
  { pattern: String.raw`vol\.`, words: "volume", beforeNumber: true, ignoreCase: true },
  { pattern: String.raw`fig\.`, words: "figure", beforeNumber: true, ignoreCase: true },
  { pattern: String.raw`ft\.`, words: "feet", afterNumber: true, mayEndSentence: true },
  afterName("Ave", "Avenue"),
];

/** Rules for English text; the rest of the numbers and abbreviations are read well by the engine. */
export function prepareEnglish(text: string): string {
  return expandAbbreviations(expandEnglishNumerals(expandEnglishYears(text)), ABBREVIATIONS);
}
