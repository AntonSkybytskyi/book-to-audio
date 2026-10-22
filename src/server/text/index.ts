import { prepareEnglish } from "./english.js";
import { normalizeText } from "./normalize.js";
import { prepareRussian } from "./russian.js";
import { prepareUkrainian } from "./ukrainian.js";

export { TEXT_PROCESSING_VERSION } from "./version.js";

const PREPARERS: Record<string, (paragraph: string) => string> = {
  en: prepareEnglish,
  uk: prepareUkrainian,
  ru: prepareRussian,
};

/**
 * The longest stretch the rules see at once. A paragraph of a real book is a few hundred
 * characters; a longer one is cut (at a sentence end, else a space, else anywhere), so that no
 * rule can take more than the square of this on any text.
 */
export const MAX_PARAGRAPH_CHARS = 5000;

/** Pieces of at most `MAX_PARAGRAPH_CHARS`, which joined are the paragraph. */
export function splitLongParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < paragraph.length;) {
    if (paragraph.length - start <= MAX_PARAGRAPH_CHARS) {
      pieces.push(paragraph.slice(start));
      break;
    }
    const window = paragraph.slice(start, start + MAX_PARAGRAPH_CHARS);
    let cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    if (cut > 0) cut += 1; // after the stop, before the space
    else cut = window.lastIndexOf(" ");
    if (cut <= 0) {
      cut = MAX_PARAGRAPH_CHARS;
      // Not between the two halves of a surrogate pair (an emoji, a rare character).
      const last = window.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    }
    pieces.push(paragraph.slice(start, start + cut));
    start += cut;
  }
  return pieces;
}

/**
 * Text as the speech engine should get it: numbers, abbreviations and the like spelled where the
 * engine would get them wrong. Deterministic, and one paragraph at a time. Bump
 * `TEXT_PROCESSING_VERSION` when a rule changes what comes out.
 */
export function prepareForSpeech(text: string, language: string): string {
  const prepare = PREPARERS[language];
  return text
    .split(/(\n\s*\n)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return splitLongParagraph(part)
        .map((piece) => {
          const clean = normalizeText(piece);
          return prepare ? prepare(clean) : clean;
        })
        .join("");
    })
    .join("");
}
