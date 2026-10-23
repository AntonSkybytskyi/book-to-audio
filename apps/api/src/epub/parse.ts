import fs from "node:fs/promises";
import { openArchive } from "./archive.js";
import { assertNoDrm } from "./drm.js";
import { EpubError } from "./errors.js";
import { readPackage, type ManifestItem, type PackageDocument } from "./package.js";
import { extractText, type ExtractedDocument } from "./text.js";
import { parseNav, parseNcx, type TocEntry } from "./toc.js";
import {
  DEFAULT_LIMITS,
  MAX_CHAPTER_TITLE_CHARS,
  MAX_TITLE_CHARS,
  type EpubChapter,
  type EpubCover,
  type ParseLimits,
  type ParsedEpub,
} from "./types.js";
import type { Archive } from "./archive.js";
import { NodeBudget } from "./xml.js";

const CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html", "application/xml"]);

interface SpineDocument {
  path: string;
  doc: ExtractedDocument;
}

/** A place in the book: which spine document, and which paragraph of it. */
interface Position {
  doc: number;
  paragraph: number;
}

/** Reads and parses an EPUB file. This is what the parser worker runs. */
export async function parseEpubFile(
  filePath: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): Promise<ParsedEpub> {
  return parseEpub(await fs.readFile(filePath), limits);
}

/**
 * Parses an EPUB 2 or 3 held in memory. Chapters follow the table of contents
 * (nav, else NCX) and fall back to spine order. Throws `EpubError` for files
 * that are not EPUBs, are DRM protected, or have no readable text.
 */
export async function parseEpub(
  data: Buffer,
  limits: ParseLimits = DEFAULT_LIMITS,
): Promise<ParsedEpub> {
  const archive = await openArchive(data, limits);

  const mimetype = await archive.readText("mimetype");
  if (mimetype !== null && mimetype.trim() !== "application/epub+zip") {
    throw new EpubError("not_epub", "This file is a zip archive, but not an EPUB.");
  }

  const budget = new NodeBudget(limits.maxNodesPerDocument, limits.maxNodesPerBook);
  await assertNoDrm(archive, budget);
  const pkg = await readPackage(archive, budget);

  const docs = await readSpineDocuments(archive, pkg, budget);
  const entries = await readToc(archive, pkg, budget);
  const chapters = buildChapters(docs, entries);
  if (chapters.length === 0) {
    throw new EpubError("no_chapters", "No readable text was found in this EPUB.");
  }
  if (chapters.length > limits.maxChapters) {
    throw new EpubError(
      "too_many_chapters",
      `This EPUB has more than ${limits.maxChapters} chapters, which is more than can be converted.`,
    );
  }

  return {
    title: clip(pkg.title ?? "Untitled", MAX_TITLE_CHARS),
    author: pkg.author && clip(pkg.author, MAX_TITLE_CHARS),
    language: pkg.language,
    cover: await readCover(archive, pkg.cover, limits.maxCoverBytes),
    chapters,
  };
}

async function readSpineDocuments(archive: Archive, pkg: PackageDocument, budget: NodeBudget) {
  const docs: SpineDocument[] = [];
  const seen = new Set<string>();
  for (const item of pkg.spine) {
    if (seen.has(item.path) || !CONTENT_TYPES.has(item.mediaType)) continue;
    seen.add(item.path);
    const html = await archive.readText(item.path);
    if (html !== null) docs.push({ path: item.path, doc: extractText(html, budget) });
  }
  return docs;
}

async function readToc(
  archive: Archive,
  pkg: PackageDocument,
  budget: NodeBudget,
): Promise<TocEntry[]> {
  const sources: [ManifestItem | null, typeof parseNav][] = [
    [pkg.nav, parseNav],
    [pkg.ncx, parseNcx],
  ];
  for (const [item, parse] of sources) {
    const text = item && (await archive.readText(item.path));
    const entries = item && text ? parse(text, item.path, budget) : [];
    if (entries.length > 0) return entries;
  }
  return [];
}

function buildChapters(docs: SpineDocument[], entries: TocEntry[]): EpubChapter[] {
  const docIndex = new Map(docs.map((d, i) => [d.path, i]));
  const located = entries.flatMap((entry) => {
    const doc = docIndex.get(entry.path);
    if (doc === undefined) return [];
    const paragraph = entry.fragment ? (docs[doc]?.doc.anchors.get(entry.fragment) ?? 0) : 0;
    return [{ title: entry.title, at: { doc, paragraph } }];
  });
  if (located.length === 0) return spineChapters(docs);

  // Stable sort: entries that share a position keep their TOC order.
  located.sort((a, b) => a.at.doc - b.at.doc || a.at.paragraph - b.at.paragraph);

  const chapters: EpubChapter[] = [];
  located.forEach((entry, i) => {
    const end = located[i + 1]?.at ?? { doc: docs.length, paragraph: 0 };
    const text = sliceText(docs, entry.at, end);
    if (text) chapters.push({ title: chapterTitle(entry.title, chapters.length), text });
  });
  return chapters;
}

/** No usable TOC: every spine document with text is a chapter. */
function spineChapters(docs: SpineDocument[]): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  for (const { doc } of docs) {
    const text = doc.paragraphs.join("\n\n");
    if (text) chapters.push({ title: chapterTitle(doc.heading, chapters.length), text });
  }
  return chapters;
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}\u2026` : value;

const chapterTitle = (title: string | null, index: number) =>
  clip(title?.trim() || `Chapter ${index + 1}`, MAX_CHAPTER_TITLE_CHARS);

/** Paragraphs from `start` up to, not including, `end`, across spine documents. */
function sliceText(docs: SpineDocument[], start: Position, end: Position): string {
  const parts: string[] = [];
  for (let d = start.doc; d <= end.doc && d < docs.length; d++) {
    const paragraphs = docs[d]?.doc.paragraphs ?? [];
    const from = d === start.doc ? start.paragraph : 0;
    const to = d === end.doc ? end.paragraph : paragraphs.length;
    for (let p = from; p < to; p++) parts.push(paragraphs[p] as string);
  }
  return parts.join("\n\n");
}

async function readCover(
  archive: Archive,
  item: ManifestItem | null,
  maxBytes: number,
): Promise<EpubCover | null> {
  if (!item) return null;
  let bytes: Buffer | null;
  try {
    bytes = await archive.readBytes(item.path, maxBytes);
  } catch {
    return null; // A broken or oversized cover must not fail the whole book.
  }
  const mime = bytes && sniffImage(bytes);
  return bytes && mime ? { bytes, mime } : null;
}

function sniffImage(bytes: Buffer): EpubCover["mime"] | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
