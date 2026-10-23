/** One chapter marker of the M4B, in milliseconds from the start of the file. */
export interface ChapterMark {
  title: string;
  startMs: number;
  endMs: number;
}

const MICROSECONDS = 1_000_000;

/**
 * The start and end of every chapter from the real lengths of the chapter files, laid end to
 * end the way the concat demuxer lays them. Lengths are summed as whole microseconds, and each
 * boundary is rounded once, so rounding never builds up over a long book.
 */
export function chapterMarks(
  chapters: readonly { title: string; durationSeconds: number }[],
): ChapterMark[] {
  let elapsedUs = 0;
  return chapters.map((chapter) => {
    const startMs = Math.round(elapsedUs / 1000);
    elapsedUs += Math.round(chapter.durationSeconds * MICROSECONDS);
    return { title: chapter.title, startMs, endMs: Math.round(elapsedUs / 1000) };
  });
}

/** Drops the control characters a tag cannot hold (a NUL cannot even be passed as an argument); line breaks stay. */
export function cleanTag(value: string): string {
  let out = "";
  for (const char of value.replace(/\r\n?/g, "\n")) {
    const code = char.codePointAt(0) ?? 0;
    const control = code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
    if (!control && code !== 0x2028 && code !== 0x2029) out += char;
  }
  return out;
}

/**
 * Escapes a value for an ffmetadata file: `=`, `;`, `#`, `\` and a line break each get a
 * backslash in front, which is what ffmpeg's reader undoes. Line breaks are made `\n` first, and
 * other control characters (a NUL would end the value early) are dropped. EPUB titles are
 * untrusted: with these escaped, a title cannot end its own line and add a `[CHAPTER]` or a tag.
 */
export function escapeMetadata(value: string): string {
  return cleanTag(value).replace(/[=;#\\\n]/g, (char) => `\\${char}`);
}

/**
 * The longest prefix of `value` that fits in `maxBytes` of UTF-8, never cutting a character
 * (or an emoji sequence's code point) in half. An ellipsis marks a cut.
 */
export function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const room = maxBytes - Buffer.byteLength("…");
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > room) break;
    out += char;
    bytes += size;
  }
  return `${out.trimEnd()}…`;
}

// The Nero chapter atom holds a title of at most 255 bytes, and ffmpeg cuts longer ones mid-character.
const CHAPTER_TITLE_BYTES = 240;
const TAG_BYTES = 1000;

/** A value for a command-line tag: no control characters, and no more than a tag should hold. */
export const tagValue = (value: string): string => clipUtf8(cleanTag(value), TAG_BYTES);

const tag = (name: string, value: string) =>
  `${name}=${escapeMetadata(clipUtf8(value, TAG_BYTES))}\n`;

export interface Ffmetadata {
  title: string;
  artist: string | null;
  album: string;
  chapters: readonly ChapterMark[];
}

/** The ffmetadata file for the M4B: the book's tags and one `[CHAPTER]` per chapter (timebase 1/1000). */
export function buildFfmetadata({ title, artist, album, chapters }: Ffmetadata): string {
  let out = ";FFMETADATA1\n";
  out += tag("title", title);
  if (artist) out += tag("artist", artist);
  out += tag("album", album);
  chapters.forEach((chapter, index) => {
    const name = chapter.title.trim() === "" ? `Chapter ${index + 1}` : chapter.title;
    out += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${chapter.startMs}\nEND=${chapter.endMs}\n`;
    out += tag("title", clipUtf8(name, CHAPTER_TITLE_BYTES));
  });
  return out;
}
