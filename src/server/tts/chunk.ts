/**
 * Splits chapter text (paragraphs separated by blank lines) into chunks of at
 * most `maxChars` characters. Sentences are kept whole where they fit, long
 * sentences are split on whitespace, and paragraph breaks inside a chunk stay
 * as single newlines so the engine can pause there.
 */
export function chunkText(text: string, maxChars: number, language = "en"): string[] {
  if (maxChars < 1) throw new RangeError("maxChars must be at least 1");

  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    let separator = current ? "\n" : "";
    for (const sentence of splitSentences(trimmed, language)) {
      for (const piece of splitLong(sentence, maxChars)) {
        if (current && current.length + separator.length + piece.length > maxChars) {
          push();
          separator = "";
        }
        current += separator + piece;
        separator = " ";
      }
    }
  }
  push();
  return chunks;
}

export function splitSentences(text: string, language: string): string[] {
  const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}

/** Splits on whitespace so each piece fits; a single word longer than the limit is cut. */
function splitLong(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];

  const pieces: string[] = [];
  let line = "";
  for (const word of sentence.split(/\s+/)) {
    for (let rest = word; rest;) {
      const room = maxChars - (line ? line.length + 1 : 0);
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest;
        break;
      }
      if (line) {
        pieces.push(line);
        line = "";
      } else {
        pieces.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
    }
  }
  if (line) pieces.push(line);
  return pieces;
}
