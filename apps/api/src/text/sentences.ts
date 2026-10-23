import {
  SENTENCE_ABBREVIATIONS,
  SENTENCE_STARTERS,
  type SentenceAbbreviations,
} from "./sentence-abbreviations.js";

/** The end of a sentence: . ! ? … in any run, then closing quotes and brackets, then a space or the end. */
const ENDING = /(?<![.!?\u2026])[.!?\u2026]+["'\u00BB\u201D\u2019)\]]*(?=\s|$)/gu;
const CLOSERS = /["'\u00BB\u201D\u2019)\]]+$/u;

/**
 * Splits a paragraph into sentences without breaking after abbreviations ("Mr.", "т. д."),
 * initials ("J. R. R. Tolkien"), or a stop that is followed by a lower-case letter. Nothing is
 * lost: the sentences joined with single spaces are the text.
 */
export function splitSentences(text: string, language: string): string[] {
  const abbreviations = SENTENCE_ABBREVIATIONS[language];
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(ENDING)) {
    const end = match.index + match[0].length;
    const rest = text.slice(end);
    if (rest.trim() !== "") {
      if (!startsNewSentence(rest)) continue;
      const singleDot = match[0].replace(CLOSERS, "") === ".";
      if (singleDot && continues(text, match.index, rest, abbreviations, language)) continue;
    }
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences.map((s) => s.trim()).filter(Boolean);
}

/** Only something that is not a lower-case letter starts a sentence: a capital, a digit, a dash or quote before one. */
function startsNewSentence(rest: string): boolean {
  const first = /^[\s"'\u00AB\u201C\u2018([\u2014-]*(\p{L}|\d)/u.exec(rest)?.[1];
  return first !== undefined && !/\p{Ll}/u.test(first);
}

function continues(
  text: string,
  dotIndex: number,
  rest: string,
  abbreviations: SentenceAbbreviations | undefined,
  language: string,
): boolean {
  const before = text.slice(Math.max(0, dotIndex - 24), dotIndex);
  const nextIsCapital = /^\s*["'«“‘(]*\p{Lu}/u.test(rest);
  // An initial: one capital letter after a space, a dot or a hyphen, with a name after it.
  const nextWord = /^[\s"'«“(]*(\p{L}+)/u.exec(rest)?.[1]?.toLowerCase() ?? "";
  // "Plan B. Then he left": a word that can only start a sentence is not part of a name.
  const startsSentence = SENTENCE_STARTERS[language]?.has(nextWord) ?? false;
  if (/(?:^|[\s.\-"'«“(])\p{Lu}$/u.test(before) && nextIsCapital && !startsSentence) return true;
  if (!abbreviations) return false;
  const lower = before.toLowerCase();
  const sets = [abbreviations.inside, abbreviations.beforeNumber, abbreviations.mayEnd] as const;
  // "т. д" is looked up without the space after its inner dot, and before any one-letter entry
  // that is only its tail ("д"); entries without dots are looked up as written.
  const collapsed = lower.replace(/\.\s+/g, ".");
  const entries = entriesOf(abbreviations);
  const find = (haystack: string, group: "compound" | "plain") =>
    entries[group].findIndex((list) => list.some((entry) => endsWith(haystack, entry)));
  const compound = find(collapsed, "compound");
  const index = compound >= 0 ? compound : find(lower, "plain");
  if (index === 0) return true; // never ends a sentence
  if (index === 1) return /^\s*\d/.test(rest);
  // Abbreviations that may end a sentence do so only before a capital letter, and not before
  // another abbreviation ("Co. Ltd.").
  if (index !== 2) return false;
  const nextIsAbbreviation = sets.some((set) => set.has(nextWord));
  return !nextIsCapital || nextIsAbbreviation;
}

/** `haystack` ends with the abbreviation `entry`, as a word of its own. */
function endsWith(haystack: string, entry: string): boolean {
  if (!haystack.endsWith(entry)) return false;
  const beforeEntry = haystack.charAt(haystack.length - entry.length - 1);
  return beforeEntry === "" || !/[\p{L}\p{N}]/u.test(beforeEntry);
}

/** The entries of each set, split into those with a dot or a space and those without, once. */
const ENTRIES = new WeakMap<SentenceAbbreviations, { compound: string[][]; plain: string[][] }>();
function entriesOf(abbreviations: SentenceAbbreviations) {
  let entries = ENTRIES.get(abbreviations);
  if (!entries) {
    const sets = [abbreviations.inside, abbreviations.beforeNumber, abbreviations.mayEnd];
    entries = {
      compound: sets.map((set) => [...set].filter((entry) => /[. ]/.test(entry))),
      plain: sets.map((set) => [...set].filter((entry) => !/[. ]/.test(entry))),
    };
    ENTRIES.set(abbreviations, entries);
  }
  return entries;
}
