import type { Case, Gender, Numerals } from "./numerals.js";

/** A noun with its forms by case. */
export type CaseForms = Record<Case, string>;
export type Triple = readonly [one: string, few: string, many: string];
export interface GenderCase {
  gender: Gender;
  case: Case;
  /** The form is also another case (Russian "часть" is a nominative and an accusative): only at the start of a paragraph. */
  atStart?: boolean;
}

export interface Currency {
  forms: Triple;
  /** Genitive: singular (after a number ending in 1) and plural, for "до 5 рублей". */
  genitive: readonly [string, string];
  gender: Gender;
  /** The hundredth part, for amounts like 5,50. */
  minor?: { forms: Triple; genitive: readonly [string, string]; gender: Gender };
}

/** Which cases the words before a number or a noun ask for. All lowercase. */
export interface Prepositions {
  /** "в", "на", "при": the locative (prepositional). */
  loc: readonly string[];
  /** Only genitive, never another case: "до", "от", "после". ("з" and "с" are not here: they also take the instrumental.) */
  gen: readonly string[];
  /** "к": the dative. */
  dat: readonly string[];
  /** "с … по": the beginning of a range, a genitive. */
  from: readonly string[];
}

/** What differs between Ukrainian and Russian in the rules of `slavic/`. */
export interface SlavicConfig {
  code: "uk" | "ru";
  numerals: Numerals;
  prepositions: Prepositions;
  /** The months in the genitive, as in "3 червня". */
  months: readonly string[];
  year: {
    /** Written-out forms after a year number and the case each one is in. */
    words: Readonly<Record<string, Case>>;
    /** The abbreviation without its dot ("г", "р"), and its plural ("гг", "рр"). */
    abbreviation: string;
    pluralAbbreviation: string;
    noun: CaseForms;
    /** "годах" (locative) and "годов" (genitive), after a range of years. */
    rangeNouns: { loc: string; gen: string; nom?: string };
    /** The case of "1999 г." given the word before the number, null when it cannot be told. */
    abbreviationCase(previous: string): Case | null;
    /** Narrows the case of a written form given the word before the number ("к 1999 году" is a dative). */
    refine?(grammaticalCase: Case, previous: string): Case;
    /** Words that follow a plural ordinal: "в 1990-е годы". */
    pluralWords: readonly string[];
  };
  century: {
    /** Forms after a Roman numeral; "amb" is a form shared by the nominative and the genitive. */
    words: Readonly<Record<string, Case | "amb">>;
    /** Forms after a range of centuries ("XVIII-XIX веках"): the case each is in, "amb" as above. */
    rangeWords: Readonly<Record<string, Case | "amb">>;
    abbreviation: string;
    pluralAbbreviation: string;
    noun: CaseForms;
    /** The noun after a range: nominative, genitive and locative plural. */
    rangeNoun: { nom: string; gen: string; loc: string };
    gender: Gender;
    /** The case of an abbreviation or of an ambiguous form, given the word before the numeral. */
    caseAfter(previous: string): Case;
  };
  /** "Глава", "Розділ" and their forms, with the gender and case each form stands for. */
  headings: Readonly<Record<string, GenderCase>>;
  suffixes: {
    /** What the ending in "5-го" stands for. */
    endings: Readonly<Record<string, GenderCase>>;
    /** "-й": a masculine nominative only before a noun that looks masculine. */
    short: string;
    /** "-м" is the instrumental or the prepositional, which the word before it tells apart. */
    byPreposition?: { ending: string; loc: readonly string[]; ins: readonly string[] };
    /** Endings that can only be plural: "-ые", "-х", "-ті" and the case each is in. */
    plural: Readonly<Record<string, Case>>;
    /** Endings that are neuter ("3-е место") or, for a decade after a plural word or a preposition, plural ("90-е"). */
    neuter: readonly string[];
    /** Neuter nouns, for "3-е место". */
    neuterNouns: readonly string[];
    /** "-й" before a word ending like this is the feminine dative or locative ("у 5-й школі", "в 5-й школе"). */
    feminineLocativeEnding: RegExp;
    /** "-й" before a word ending like this is the feminine genitive ("с 3-й попытки"). */
    feminineGenitiveEnding: RegExp;
    /** Whether a bare "-й" with no word after it is a masculine nominative ("зайняв 3-й"). */
    bareShortIsMasculine: boolean;
  };
  /**
   * Nouns in the singular locative that a number before them numbers ("на 5 сторінці" is "на
   * п'ятій сторінці"), with their gender. A year ("році") is not one: a number there is a year.
   */
  locativeNouns: Readonly<Record<string, Gender>>;
  /** Regnal names with the gender and case each form is in: "Людовик" (nom), "Людовика" (gen). */
  regnal: Readonly<Record<string, GenderCase>>;
  percent: { forms: Triple; genitive: readonly [string, string] };
  decimal: {
    /** "целая / целых" after a whole part. */
    whole: Triple;
    /** Denominators of 1, 2 and 3 digits: "десятая / десятых", "сотая / сотых", "тысячная / тысячных". */
    fractions: readonly [Triple, Triple, Triple];
    /** In the genitive: whole part "цілої / цілих", denominators "десятої / десятих". */
    wholeGenitive: readonly [string, string];
    fractionsGenitive: readonly [
      readonly [string, string],
      readonly [string, string],
      readonly [string, string],
    ];
  };
  /** Keyed by the symbol or abbreviation written after (or before) the amount, lowercase. */
  currencies: Readonly<Record<string, Currency>>;
}
