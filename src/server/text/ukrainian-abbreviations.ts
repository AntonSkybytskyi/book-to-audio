import type { AbbreviationRule } from "./abbreviations.js";

const LOC = ["у", "в", "на", "при", "о"];
const GEN = ["з", "із", "від", "до", "біля", "поблизу", "навколо", "для", "без", "після"];

/** The name of a town or a figure follows in the case of the word: "у м. Києві" is "у місті Києві". */
/** Nouns of things that are named after somebody: "школа імені", "вулиця імені". */
const NAMED_AFTER = [
  "вул",
  "просп",
  "пл",
  "наб",
  "школ",
  "інститут",
  "університет",
  "вулиц",
  "бібліотек",
  "театр",
  "завод",
  "площ",
  "музе",
  "проспект",
  "парк",
  "гімнази",
  "ліце",
  "коледж",
  "академі",
  "лікарн",
  "фабрик",
  "колгосп",
  "клуб",
  "палац",
  "стадіон",
  "санаторі",
  "набережн",
  "бульвар",
  "вокзал",
  "аеропорт",
  "порт",
  "пароплав",
  "корабл",
  "полк",
  "дивізі",
  "премі",
  "фонд",
  "центр",
  "філармоні",
  "консерваторі",
  "цирк",
  "обсерваторі",
  "лабораторі",
  "орден",
  "медал",
];

const byPreposition = (nom: string, gen: string, loc: string) => (previous: string) =>
  LOC.includes(previous) ? loc : GEN.includes(previous) ? gen : nom;

// espeak is not involved for Ukrainian (the voice reads letters), so every abbreviation that is
// not expanded here is read letter by letter.
export const UKRAINIAN_ABBREVIATIONS: readonly AbbreviationRule[] = [
  { pattern: String.raw`[Тт]\.\s?д\.`, words: "так далі", mayEndSentence: true },
  { pattern: String.raw`[Тт]\.\s?п\.`, words: "таке інше", mayEndSentence: true },
  { pattern: String.raw`[Тт]\.\s?ін\.`, words: "таке інше", mayEndSentence: true },
  { pattern: String.raw`[Тт]\.\s?б\.`, words: "тобто" },
  { pattern: String.raw`та\s+ін\.`, words: "та інші", ignoreCase: true, mayEndSentence: true },
  { pattern: String.raw`і\s+ін\.`, words: "і інші", ignoreCase: true, mayEndSentence: true },
  { pattern: String.raw`напр\.`, words: "наприклад", ignoreCase: true },
  { pattern: String.raw`пор\.`, words: "порівняйте", ignoreCase: true },
  { pattern: String.raw`див\.`, words: "дивіться", ignoreCase: true },
  {
    pattern: String.raw`ім\.`,
    words: "імені",
    ignoreCase: true,
    beforeCapital: true,
    afterNounStems: NAMED_AFTER,
  },
  { pattern: String.raw`проф\.`, words: "професор", ignoreCase: true, beforeCapital: true },
  { pattern: String.raw`акад\.`, words: "академік", ignoreCase: true, beforeCapital: true },
  { pattern: String.raw`рис\.`, words: "рисунок", ignoreCase: true, beforeNumber: true },
  { pattern: String.raw`т\.`, words: "том", beforeNumber: true },
  { pattern: String.raw`ст\.`, words: "стаття", beforeNumber: true },
  { pattern: String.raw`ч\.`, words: "частина", beforeNumber: true },
  { pattern: String.raw`с\.`, words: "сторінка", beforeNumber: true },
  { pattern: String.raw`п\.`, words: "пункт", beforeNumber: true },
  { pattern: String.raw`розд\.`, words: "розділ", ignoreCase: true, beforeNumber: true },
  { pattern: String.raw`гл\.`, words: "глава", ignoreCase: true, beforeNumber: true },
  { pattern: String.raw`табл\.`, words: "таблиця", ignoreCase: true, beforeNumber: true },
  { pattern: String.raw`вип\.`, words: "випуск", ignoreCase: true, beforeNumber: true },
  { pattern: String.raw`кн\.`, words: "книга", ignoreCase: true, beforeNumber: true },
  {
    pattern: String.raw`м\.`,
    words: byPreposition("місто", "міста", "місті"),
    beforeCapital: true,
    notAfterNumber: true,
  },
];
