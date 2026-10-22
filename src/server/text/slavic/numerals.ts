export type Gender = "m" | "f" | "n";
/** Ordinals also have a plural ("девяностые годы"); numbers do not agree with it in gender. */
export type OrdinalGender = Gender | "p";
/** Ukrainian and Russian cases; the locative (uk) and the prepositional (ru) share `loc`. */
export type Case = "nom" | "gen" | "dat" | "acc" | "ins" | "loc";

export interface Numerals {
  /** Number in words, nominative; `gender` matters for 1 and 2 (and the thousands are feminine). */
  cardinal(n: number, gender?: Gender): string;
  /**
   * Ordinal in words, only the last word declined ("тысяча девятьсот девяносто девятом").
   * Null outside 1 to 2999.
   */
  ordinal(n: number, gender: OrdinalGender, grammaticalCase: Case): string | null;
  /**
   * A decade as in "1990-е" or "90-е": the ordinal of the last two digits in the plural
   * ("девяностые"), a century-long one in full ("тысяча девятисотые"), the 2000s with their thousands.
   */
  decade(n: number, grammaticalCase: Case): string | null;
  /** Cardinal in the genitive ("п'яти", "двадцяти одного"), after "до", "від", "з". Absent when not supported. */
  cardinalGenitive?(n: number, gender?: Gender): string;
  /** The form of a counted noun after `n`: `one` for 21, `few` for 22 to 24, `many` otherwise. */
  plural(n: number, forms: readonly [one: string, few: string, many: string]): string;
}

export interface NumeralData {
  /** 0 to 9, per gender (only 1 and 2 differ). */
  units: Record<Gender, readonly string[]>;
  /** 10 to 19. */
  teens: readonly string[];
  /** 20 to 90, in steps of 10, starting at 20. */
  tens: readonly string[];
  /** 100 to 900. */
  hundreds: readonly string[];
  /** Scales: thousand (feminine), million, billion, each as [one, few, many]. */
  scales: readonly (readonly [string, string, string])[];
  /** Ordinals in the masculine nominative: 1 to 19, then 20 to 90, then 100 to 900. */
  ordinalUnits: readonly string[];
  ordinalTens: readonly string[];
  ordinalHundreds: readonly string[];
  /** "тысячный" and "двухтысячный". */
  ordinalThousands: readonly [string, string];
  /** Declines an ordinal given in the masculine nominative. */
  decline(form: string, gender: OrdinalGender, grammaticalCase: Case): string;
  /** The same numbers in the genitive, for languages that decline cardinals here. */
  genitive?: {
    units: Record<Gender, readonly string[]>;
    teens: readonly string[];
    tens: readonly string[];
    hundreds: readonly string[];
    /** Scale words with the genitive singular (after a group ending in 1) and plural. */
    scales: readonly (readonly [string, string])[];
  };
}

const MAX_CARDINAL = 999_999_999_999;

export function pluralIndex(n: number): 0 | 1 | 2 {
  const lastTwo = n % 100;
  const last = n % 10;
  if (last === 1 && lastTwo !== 11) return 0;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 1;
  return 2;
}

export function createNumerals(data: NumeralData): Numerals {
  const below1000 = (n: number, gender: Gender): string[] => {
    const words: string[] = [];
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (hundreds) words.push(data.hundreds[hundreds - 1] as string);
    if (rest >= 20) {
      words.push(data.tens[Math.floor(rest / 10) - 2] as string);
      if (rest % 10) words.push((data.units[gender] as readonly string[])[rest % 10] as string);
    } else if (rest >= 10) {
      words.push(data.teens[rest - 10] as string);
    } else if (rest > 0) {
      words.push((data.units[gender] as readonly string[])[rest] as string);
    }
    return words;
  };

  const cardinal = (n: number, gender: Gender = "m"): string => {
    if (!Number.isInteger(n) || n < 0 || n > MAX_CARDINAL) {
      throw new RangeError(`cannot spell ${n}`);
    }
    if (n === 0) return data.units.m[0] as string;
    const words: string[] = [];
    // Groups of three digits, from the largest scale down.
    for (let scale = data.scales.length; scale >= 0; scale--) {
      const group = Math.floor(n / 1000 ** scale) % 1000;
      if (group === 0) continue;
      if (scale === 0) {
        words.push(...below1000(group, gender));
        continue;
      }
      const forms = data.scales[scale - 1] as readonly [string, string, string];
      // A lone thousand is just "тысяча"; other groups say their count first.
      if (!(scale === 1 && group === 1)) words.push(...below1000(group, scale === 1 ? "f" : "m"));
      words.push(forms[pluralIndex(group)]);
    }
    return words.join(" ");
  };

  const ordinal = (n: number, gender: OrdinalGender, grammaticalCase: Case): string | null => {
    if (!Number.isInteger(n) || n < 1 || n > 2999) return null;
    let last: string;
    let rest: number; // what is spelled as a cardinal before the ordinal word
    if (n % 1000 === 0) {
      last = data.ordinalThousands[n / 1000 - 1] as string;
      rest = 0;
    } else if (n % 100 === 0) {
      last = data.ordinalHundreds[(n % 1000) / 100 - 1] as string;
      rest = n - (n % 1000);
    } else if (n % 100 < 20) {
      last = data.ordinalUnits[(n % 100) - 1] as string;
      rest = n - (n % 100);
    } else if (n % 10 === 0) {
      last = data.ordinalTens[((n % 100) - 20) / 10] as string;
      rest = n - (n % 100);
    } else {
      last = data.ordinalUnits[(n % 10) - 1] as string;
      rest = n - (n % 10);
    }
    const head = rest > 0 ? `${cardinal(rest)} ` : "";
    return head + data.decline(last, gender, grammaticalCase);
  };

  const decade = (n: number, grammaticalCase: Case): string | null => {
    if (!Number.isInteger(n) || n < 10 || n % 10 !== 0) return null;
    // 1990s: "девяностые", not "тысяча девятьсот девяностые".
    const short = n >= 1100 && n < 2000 && n % 100 !== 0 ? n % 100 : n;
    return ordinal(short, "p", grammaticalCase);
  };

  const { genitive } = data;
  const genitiveGroup = (n: number, gender: Gender): string[] => {
    if (!genitive) return [];
    const words: string[] = [];
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (hundreds) words.push(genitive.hundreds[hundreds - 1] as string);
    if (rest >= 20) {
      words.push(genitive.tens[Math.floor(rest / 10) - 2] as string);
      if (rest % 10) words.push((genitive.units[gender] as readonly string[])[rest % 10] as string);
    } else if (rest >= 10) {
      words.push(genitive.teens[rest - 10] as string);
    } else if (rest > 0) {
      words.push((genitive.units[gender] as readonly string[])[rest] as string);
    }
    return words;
  };
  const cardinalGenitive = genitive
    ? (n: number, gender: Gender = "m"): string => {
        if (!Number.isInteger(n) || n < 0 || n > MAX_CARDINAL) {
          throw new RangeError(`cannot spell ${n}`);
        }
        if (n === 0) return "нуля";
        const words: string[] = [];
        for (let scale = genitive.scales.length; scale >= 0; scale--) {
          const group = Math.floor(n / 1000 ** scale) % 1000;
          if (group === 0) continue;
          if (scale === 0) {
            words.push(...genitiveGroup(group, gender));
            continue;
          }
          const forms = genitive.scales[scale - 1] as readonly [string, string];
          if (!(scale === 1 && group === 1)) {
            words.push(...genitiveGroup(group, scale === 1 ? "f" : "m"));
          }
          words.push(forms[pluralIndex(group) === 0 ? 0 : 1]);
        }
        return words.join(" ");
      }
    : undefined;

  return {
    cardinal,
    ordinal,
    decade,
    plural: (n, forms) => forms[pluralIndex(n)],
    ...(cardinalGenitive ? { cardinalGenitive } : {}),
  };
}

/** Endings by [gender][case] in the order nom, gen, dat, acc, ins, loc. */
export type Endings = Record<
  OrdinalGender,
  readonly [string, string, string, string, string, string]
>;

const CASE_INDEX: Record<Case, number> = { nom: 0, gen: 1, dat: 2, acc: 3, ins: 4, loc: 5 };

/** Replaces the last `cut` letters of `form` with the ending for the gender and case. */
export function withEnding(
  form: string,
  cut: number,
  endings: Endings,
  gender: OrdinalGender,
  grammaticalCase: Case,
): string {
  return form.slice(0, -cut) + endings[gender][CASE_INDEX[grammaticalCase]];
}
