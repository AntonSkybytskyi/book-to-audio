import { transliterate } from "./translit.js";

/** File names for the downloads, made from book and chapter titles, which come from the EPUB and are untrusted. */

const MAX_GRAPHEMES = 100;
// Most file systems allow 255 bytes per name. The number in front and the extension take about 15.
const MAX_BYTES = 200;
// A download name holds a title and an author: each gets less, so the two together stay near 200 bytes.
const PART_BYTES = 90;
const FALLBACK = "Untitled";
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SEPARATORS_AND_RESERVED = /[\\/:*?"<>|]/g;
// Controls, line and paragraph separators, and format characters (a right-to-left override can
// make "gpj.exe" look like "exe.jpg"). The joiners stay: scripts such as Devanagari need them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]/gu;
const JOINERS = new Set(["\u200c", "\u200d"]);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A title made safe to use as (part of) a file name on any system: no path separators or
 * `:*?"<>|`, no control or invisible characters, no leading dots or trailing dots and spaces,
 * not a reserved Windows name, and cut to about 100 characters. Letters of every script stay.
 */
export function sanitizeFileName(title: string, fallback = FALLBACK, maxBytes = MAX_BYTES): string {
  let name = title
    .normalize("NFC")
    .replace(INVISIBLE, (char) => (JOINERS.has(char) ? char : " "))
    .replace(SEPARATORS_AND_RESERVED, " ")
    .replace(/\s+/g, " ");
  name = clip(name.replace(/^[.\s]+/, ""), maxBytes);
  name = name.replace(/[.\s]+$/, "");
  // `CON` and `CON.txt` are both the console on Windows.
  if (RESERVED.test(name.split(".")[0]?.trim() ?? "")) name = `_${name}`;
  return name === "" ? fallback : name;
}

/** At most 100 characters (as a reader counts them) and `maxBytes` bytes, never cutting one in half. */
function clip(name: string, maxBytes: number): string {
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(name)) {
    if (count === MAX_GRAPHEMES || Buffer.byteLength(out + segment) > maxBytes) break;
    out += segment;
    count++;
  }
  return out;
}

/** `01 - Title.webm` numbers, zero padded to the width of the chapter count (at least 2). */
export function paddedNumber(position: number, total: number): string {
  return String(position).padStart(Math.max(2, String(total).length), "0");
}

/**
 * The name of every chapter file in the ZIP, in chapter order: `01 - Title.webm`. The number
 * already makes names differ, but two names that are the same ignoring case (an unzip on a
 * case-insensitive disk would merge them) get ` (2)`, ` (3)`… as well.
 */
export function chapterFileNames(titles: readonly string[]): string[] {
  const used = new Set<string>();
  return titles.map((title, index) => {
    const base = `${paddedNumber(index + 1, titles.length)} - ${sanitizeFileName(title, "Chapter")}`;
    let name = `${base}.webm`;
    for (let copy = 2; used.has(name.toLowerCase()); copy++) name = `${base} (${copy}).webm`;
    used.add(name.toLowerCase());
    return name;
  });
}

const baseName = (title: string, author: string) => (author ? `${title} - ${author}` : title);
const withExtension = (kind: "m4b" | "zip", base: string) =>
  kind === "m4b" ? `${base}.m4b` : `${base} (WebM).zip`;

/** `Title - Author.m4b` and `Title - Author (WebM).zip`; the author is left out when unknown. */
export function downloadFileName(
  kind: "m4b" | "zip",
  book: { title: string; author: string | null },
): string {
  const title = sanitizeFileName(book.title, "Audiobook", PART_BYTES);
  const author = book.author ? sanitizeFileName(book.author, "", PART_BYTES) : "";
  return withExtension(kind, baseName(title, author));
}

/**
 * The same name for the plain `filename=` parameter, in printable ASCII: Ukrainian and Russian are
 * transliterated, accents are dropped, and a title or author with no Latin letters left (CJK) is left
 * out instead of becoming a row of underscores. Without either, it is `audiobook.m4b` or `audiobook (WebM).zip`.
 */
export function asciiDownloadName(
  kind: "m4b" | "zip",
  book: { title: string; author: string | null; language?: string },
): string {
  const language = book.language ?? "";
  return withExtension(
    kind,
    baseName(asciiPart(book.title, language) || "audiobook", asciiPart(book.author, language)),
  );
}

/** The plain-ASCII form of a title or author, or "" when no Latin letter or digit is left in it. */
function asciiPart(text: string | null, language: string): string {
  const ascii = text
    ? asciiText(transliterate(sanitizeFileName(text, "", PART_BYTES), language))
    : "";
  return /[A-Za-z0-9]/.test(ascii) ? ascii : "";
}

/** Accents dropped, other non-ASCII characters removed, quotes and `%` and `\` replaced. */
function asciiText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/["\\%]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/** `Content-Disposition: attachment` with an ASCII `filename=` and the real name in `filename*=` (RFC 6266 / 5987). */
export function contentDisposition(name: string, fallback: string): string {
  const encoded = encodeURIComponent(name.replace(/\p{Cs}/gu, "\uFFFD")).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // The caller passes plain ASCII; this makes sure nothing else can end up between the quotes.
  const plain = fallback.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}
