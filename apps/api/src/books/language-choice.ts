import { detectLanguage } from "./language-detect.js";
import { declaredLanguage, type Language } from "./languages.js";
import type { LanguageSource } from "@book-to-audio/contracts";
export type { LanguageSource } from "@book-to-audio/contracts";

export interface LanguageChoice {
  language: Language;
  source: LanguageSource;
  /** 0 to 1; how sure the text detection was (0 when it did not decide). */
  confidence: number;
  /** The language the book's metadata names, when it is a supported one. */
  declared: Language | null;
}

/** A verdict at or above this decides the language. */
export const CONFIDENT = 0.7;

const SAMPLE_CHARS = 60_000;
const WINDOWS = 40;

/**
 * A bounded sample of the book that comes from all of it, not from its first pages (they are
 * often a copyright notice in another language): short books are used whole, long ones as
 * evenly spaced windows over the chapters taken together.
 */
export function sampleBookText(chapters: readonly { text: string }[]): string {
  const total = chapters.reduce((sum, c) => sum + c.text.length, 0);
  if (total <= SAMPLE_CHARS) return chapters.map((c) => c.text).join("\n\n");

  const windowChars = Math.floor(SAMPLE_CHARS / WINDOWS);
  const parts: string[] = [];
  let chapterStart = 0;
  let chapter = 0;
  for (let i = 0; i < WINDOWS; i++) {
    const position = Math.floor((i * total) / WINDOWS);
    while (
      chapter < chapters.length - 1 &&
      chapterStart + (chapters[chapter]?.text.length ?? 0) <= position
    ) {
      chapterStart += chapters[chapter]?.text.length ?? 0;
      chapter++;
    }
    const text = chapters[chapter]?.text ?? "";
    const from = Math.min(
      Math.max(0, position - chapterStart),
      Math.max(0, text.length - windowChars),
    );
    parts.push(text.slice(from, from + windowChars));
  }
  return parts.join("\n\n");
}

/**
 * The language to pre-select. The text decides when the detector is confident; otherwise the
 * book's own `dc:language` does, if it names a supported language; otherwise nobody knows and
 * English is only a placeholder (`source: "unknown"`), which the preview says out loud. A book in
 * a language the app does not support is never given a confident English; the one exception is a
 * Latin-script text of a book whose metadata says Ukrainian or Russian (the preview asks to check).
 */
export function chooseLanguage(
  chapters: readonly { text: string }[],
  declaredTag: string | null,
): LanguageChoice {
  const declared = declaredLanguage(declaredTag);
  const detection = detectLanguage(sampleBookText(chapters));

  if (detection.kind === "language" && detection.confidence >= CONFIDENT) {
    return {
      language: detection.language,
      source: "detected",
      confidence: detection.confidence,
      declared,
    };
  }
  if (detection.kind === "other" && detection.confidence >= CONFIDENT) {
    // Ukrainian and Russian books are often mostly Latin letters (product names, quotations):
    // when the text is no other Latin-script language the app would recognise, metadata that
    // names one of them is what there is. Cyrillic text of another language never is.
    if (detection.script === "latin" && (declared === "uk" || declared === "ru")) {
      return { language: declared, source: "metadata", confidence: 0, declared };
    }
    return { language: "en", source: "unknown", confidence: 0, declared };
  }
  if (declared) return { language: declared, source: "metadata", confidence: 0, declared };
  return { language: "en", source: "unknown", confidence: 0, declared };
}
