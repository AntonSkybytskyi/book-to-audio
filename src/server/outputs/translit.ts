/**
 * Latin spelling of Ukrainian and Russian text (the Ukrainian national transliteration of 2010,
 * with the Russian letters added) and of the Latin letters that do not break down into a letter
 * and an accent. It gives old download clients, which cannot read `filename*=`, something
 * readable instead of a row of underscores. Everything it does not know is left as it is.
 */

// Letters that read differently at the start of a word.
const WORD_START: Record<string, string> = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "h",
  ґ: "g",
  д: "d",
  е: "e",
  є: "ie",
  ж: "zh",
  з: "z",
  и: "y",
  і: "i",
  ї: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ь: "",
  ю: "iu",
  я: "ia",
  ъ: "",
  ы: "y",
  э: "e",
  ё: "yo",
};

const LATIN: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ħ: "h",
  ı: "i",
};

// Where Russian differs from Ukrainian (the same letters read differently).
const RUSSIAN: Record<string, string> = {
  г: "g",
  и: "i",
  й: "y",
  ю: "yu",
  я: "ya",
  ы: "y",
  э: "e",
  ё: "yo",
};

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `Тіні забутих предків` becomes `Tini zabutykh predkiv`. For `ru` the Russian readings of the
 * letters the two languages share are used (`Война и мир` becomes `Voyna i mir`); any other
 * language gets the Ukrainian ones.
 */
export function transliterate(text: string, language?: string): string {
  const russian = language === "ru";
  let out = "";
  let atWordStart = true;
  for (const char of text) {
    const lower = char.toLowerCase();
    const isUpper = lower !== char;
    const spelled =
      (russian ? RUSSIAN[lower] : undefined) ??
      (atWordStart && !russian ? WORD_START[lower] : undefined) ??
      CYRILLIC[lower] ??
      LATIN[lower];
    if (spelled === undefined) {
      out += char;
    } else {
      out += isUpper ? capitalise(spelled) : spelled;
    }
    atWordStart = !/[\p{L}\p{N}']/u.test(char);
  }
  return out;
}
