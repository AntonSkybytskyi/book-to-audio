import { plainNumeral } from "./roman.js";
import { ukrainian } from "./ukrainian-config.js";

// The Ukrainian voice has no Latin letters, so a Latin token would be skipped. What is left of
// them after the rules is read the way a Ukrainian reader would: numerals as numbers, short all
// capital tokens (USA, BBC) letter by letter, other words as an approximation of their sound.

const DIGRAPHS: readonly (readonly [string, string])[] = [
  ["sch", "ш"],
  ["tch", "ч"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["kh", "х"],
  ["th", "т"],
  ["ph", "ф"],
  ["ck", "к"],
  ["qu", "кв"],
  ["ee", "і"],
  ["oo", "у"],
];
const LETTERS: Record<string, string> = {
  a: "а",
  b: "б",
  c: "к",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "г",
  i: "і",
  j: "дж",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "кс",
  y: "і",
  z: "з",
};
/** How a Ukrainian reader says the name of an English letter. */
const LETTER_NAMES: Record<string, string> = {
  a: "ей",
  b: "бі",
  c: "сі",
  d: "ді",
  e: "і",
  f: "еф",
  g: "джі",
  h: "ейч",
  i: "ай",
  j: "джей",
  k: "кей",
  l: "ел",
  m: "ем",
  n: "ен",
  o: "оу",
  p: "пі",
  q: "кью",
  r: "ар",
  s: "ес",
  t: "ті",
  u: "ю",
  v: "ві",
  w: "дабл-ю",
  x: "екс",
  y: "вай",
  z: "зед",
};
const SPECIAL: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d" };

/** "é" is "e", "ñ" is "n", "ß" is "ss". */
function plainLatin(token: string): string {
  return token
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßæœøłđ]/giu, (c) => SPECIAL[c.toLowerCase()] ?? c);
}

function transliterateWord(word: string): string {
  const lower = word.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length;) {
    const digraph = DIGRAPHS.find(([latin]) => lower.startsWith(latin, i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    const letter = lower[i] as string;
    // "c" is soft before e, i, y; "y" opens a word as "й" before a vowel (York, Yes).
    if (letter === "c" && /[eiy]/.test(lower[i + 1] ?? "")) out += "с";
    else if (letter === "y" && i === 0 && /[aeiou]/.test(lower[i + 1] ?? "")) out += "й";
    else out += LETTERS[letter] ?? "";
    i++;
  }
  return word[0] === word[0]?.toUpperCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

function readLatinToken(raw: string): string {
  const token = plainLatin(raw);
  // A Roman numeral that no rule placed ("XIX") is a number, never a word.
  const numeral = plainNumeral(token);
  if (numeral !== null) return ukrainian.numerals.cardinal(numeral);
  if (/^[A-Z]{1,5}$/.test(token)) {
    return [...token].map((c) => LETTER_NAMES[c.toLowerCase()]).join(" ");
  }
  return transliterateWord(token);
}

export function transliterateLatin(text: string): string {
  return text.replace(/[A-Za-zÀ-ɏ]+/g, readLatinToken);
}
