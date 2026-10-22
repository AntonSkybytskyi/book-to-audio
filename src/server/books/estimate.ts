// Placeholder until slice 6 measures the real speaking rate and conversion speed.
const WORDS_PER_MINUTE = 150;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Rough listening time in minutes, at least 1 for any text. */
export function estimateMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
