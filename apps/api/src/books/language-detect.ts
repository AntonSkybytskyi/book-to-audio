import {
  ENGLISH_WORDS,
  OTHER_LATIN_WORDS,
  RUSSIAN_WORDS,
  UKRAINIAN_WORDS,
} from "./language-words.js";
import type { Language } from "./languages.js";

export type Detection =
  | { kind: "language"; language: Language; confidence: number }
  /** A language the app does not support, with some certainty, and the script the text is in. */
  | { kind: "other"; confidence: number; script: "latin" | "cyrillic" }
  /** Too little text, or text that no list recognises. */
  | { kind: "unsure" };

/** Least letters and words before a verdict. */
const MIN_LETTERS = 150;
const MIN_LATIN_WORDS = 40;
const WORD = /[\p{L}][\p{L}'’ʼ-]*/gu;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Which supported language `text` is in. Cyrillic against Latin is the share of letters; Ukrainian
 * against Russian is counted from the letters only one of them uses (і ї є ґ against ы э ё) plus
 * function words that mark one of them; English is its share of very frequent English words,
 * compared with other Latin-script languages so that German is not mistaken for a poor English.
 */
export function detectLanguage(text: string): Detection {
  const cyrillic = count(text, /\p{Script=Cyrillic}/gu);
  const latin = count(text, /\p{Script=Latin}/gu);
  if (cyrillic + latin < MIN_LETTERS) return { kind: "unsure" };
  return cyrillic >= latin ? detectCyrillic(text, cyrillic) : detectLatin(text);
}

function detectCyrillic(text: string, letters: number): Detection {
  const lower = text.toLowerCase();
  const ukLetters = count(lower, /[іїєґ]/gu);
  const ruLetters = count(lower, /[ыэё]/gu);
  // Belarusian, Serbian, Macedonian, Kazakh, Tatar, Kyrgyz, Mongolian, Chuvash ... are Cyrillic
  // too, with letters of their own, and not supported: ы э ё alone must not make them Russian.
  const other = count(lower, /[ђћљњџѓќѕјўәғқңөұүһҗӑӗӣ]/gu);
  const bulgarian = count(lower, /ъ/gu) > letters * 0.015 && ruLetters < letters * 0.002;
  if (other > letters * 0.005 || bulgarian) {
    return { kind: "other", confidence: 0.9, script: "cyrillic" };
  }

  let ukWords = 0;
  let ruWords = 0;
  for (const word of lower.match(WORD) ?? []) {
    if (UKRAINIAN_WORDS.has(word)) ukWords++;
    if (RUSSIAN_WORDS.has(word)) ruWords++;
  }
  const uk = ukLetters + ukWords;
  const ru = ruLetters + ruWords;
  const evidence = uk + ru;
  if (evidence < 12) return { kind: "unsure" };
  const share = uk / evidence;
  // 30 pieces of evidence, all on one side, make a certain verdict; a mixed share lowers it.
  const confidence = clamp(Math.abs(2 * share - 1)) * clamp(evidence / 30);
  return { kind: "language", language: share >= 0.5 ? "uk" : "ru", confidence };
}

function detectLatin(text: string): Detection {
  const tokens = text.toLowerCase().match(WORD) ?? [];
  if (tokens.length < MIN_LATIN_WORDS) return { kind: "unsure" };
  const rate = (list: ReadonlySet<string>) =>
    tokens.reduce((n, token) => n + (list.has(token) ? 1 : 0), 0) / tokens.length;
  const english = rate(ENGLISH_WORDS);
  const rival = Math.max(...OTHER_LATIN_WORDS.map(rate));
  // English prose is 35 to 50 percent these words; German, French and the others stay well below 15.
  if (english >= 0.22 && english > rival * 1.3) {
    return { kind: "language", language: "en", confidence: clamp((english - 0.05) / 0.25) };
  }
  if (english < 0.15 && rival >= 0.18) {
    return { kind: "other", confidence: clamp(rival / 0.3), script: "latin" };
  }
  if (english < 0.1) return { kind: "other", confidence: 0.7, script: "latin" };
  return { kind: "unsure" };
}
