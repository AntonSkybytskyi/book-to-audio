/**
 * Invisible and odd characters out, special spaces to plain ones, runs of spaces squeezed.
 * Line breaks stay: they separate paragraphs.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u2009\u202F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}
