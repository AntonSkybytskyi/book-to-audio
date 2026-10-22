export interface EpubCover {
  bytes: Buffer;
  /** Sniffed from the bytes, never taken from the manifest. */
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface EpubChapter {
  title: string;
  /** Paragraphs separated by a blank line. Never empty. */
  text: string;
}

export interface ParsedEpub {
  title: string;
  author: string | null;
  /** Raw `dc:language` (for example `en-US`), if the book declares one. */
  language: string | null;
  cover: EpubCover | null;
  chapters: EpubChapter[];
}

export interface ParseLimits {
  /** Entries in the zip, files and folders. */
  maxEntries: number;
  /** Sum of the declared uncompressed sizes of all entries. */
  maxDeclaredBytes: number;
  /** Bytes actually inflated while reading the text documents of one book. */
  maxTextBytes: number;
  /** Largest cover image that is kept. */
  maxCoverBytes: number;
  /** Inflated size of one XML or XHTML document. */
  maxDocumentBytes: number;
  /** Elements and text runs in one document. */
  maxNodesPerDocument: number;
  /** Elements and text runs in all documents of one book. */
  maxNodesPerBook: number;
  maxChapters: number;
}

export const MAX_TITLE_CHARS = 300;
export const MAX_CHAPTER_TITLE_CHARS = 200;

export const DEFAULT_LIMITS: ParseLimits = {
  maxEntries: 20_000,
  maxDeclaredBytes: 1024 ** 3,
  maxTextBytes: 256 * 1024 ** 2,
  maxCoverBytes: 16 * 1024 ** 2,
  maxDocumentBytes: 20 * 1024 ** 2,
  maxNodesPerDocument: 500_000,
  maxNodesPerBook: 5_000_000,
  maxChapters: 2000,
};
