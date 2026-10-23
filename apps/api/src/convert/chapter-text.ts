import { prepareForSpeech } from "../text/index.js";
import { chunkText } from "../tts/chunk.js";

/** A chapter's text as the chunks the engine reads: prepared for the language, then split. */
export function prepareChunks(text: string, language: string, maxChars: number): string[] {
  return chunkText(prepareForSpeech(text, language), maxChars, language);
}

/**
 * Prepares a chapter's text. Production runs it in a worker thread with a time limit
 * (`text-preparer.ts`); tests and anything that trusts the text run it in place.
 */
export type TextPreparer = (
  text: string,
  language: string,
  maxChars: number,
  signal?: AbortSignal,
) => Promise<string[]>;

export const prepareInThread: TextPreparer = async (text, language, maxChars) =>
  prepareChunks(text, language, maxChars);
