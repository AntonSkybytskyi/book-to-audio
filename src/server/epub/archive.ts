import type { Readable } from "node:stream";
import JSZip from "jszip";
import { EpubError } from "./errors.js";
import type { ParseLimits } from "./types.js";
import { countZipEntries } from "./zip-header.js";

export interface Archive {
  has(path: string): boolean;
  /** Entry names exactly as stored. Only ever used as lookup keys, never as file paths. */
  names(): string[];
  /** Null when the entry does not exist. */
  readBytes(path: string, maxBytes: number): Promise<Buffer | null>;
  readText(path: string): Promise<string | null>;
}

/**
 * Opens a zip held in memory. The archive is checked up front (entry count and
 * declared sizes) and every read is metered while inflating, because declared
 * sizes in a hostile file can lie.
 */
export async function openArchive(data: Buffer, limits: ParseLimits): Promise<Archive> {
  const entryCount = countZipEntries(data, limits.maxEntries);
  if (entryCount !== null && entryCount > limits.maxEntries)
    throw unsafe("it contains too many files");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (error) {
    throw new EpubError("not_epub", "This file is not a valid EPUB (it is not a zip archive).", {
      cause: error,
    });
  }

  const files = new Map<string, JSZip.JSZipObject>();
  let declared = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (files.size >= limits.maxEntries) throw unsafe("it contains too many files");
    files.set(name, entry);
    declared += declaredSize(entry);
    if (declared > limits.maxDeclaredBytes) throw unsafe("it would unpack to too much data");
  }

  let textBudget = limits.maxTextBytes;

  const readBytes = async (path: string, maxBytes: number) => {
    const entry = files.get(path);
    if (!entry || entry.dir) return null;
    // Cap this entry by what is left of the shared budget, not just its own limit.
    const bytes = await inflate(entry, Math.min(maxBytes, textBudget));
    textBudget -= bytes.length;
    return bytes;
  };

  return {
    has: (path) => files.has(path),
    names: () => [...files.keys()],
    readBytes,
    async readText(path) {
      const bytes = await readBytes(path, Math.min(limits.maxDocumentBytes, textBudget));
      return bytes && decodeText(bytes);
    },
  };
}

const unsafe = (reason: string) =>
  new EpubError("unsafe_archive", `This EPUB was rejected because ${reason}.`);

function declaredSize(entry: JSZip.JSZipObject): number {
  // JSZip keeps the size from the zip's central directory on a private field.
  const internals = (entry as unknown as Record<string, { uncompressedSize?: number } | undefined>)[
    "_data"
  ];
  return typeof internals?.uncompressedSize === "number" ? internals.uncompressedSize : 0;
}

function inflate(entry: JSZip.JSZipObject, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    // JSZip's stream is a readable-stream instance; it is driven by events, not `for await`.
    const stream = entry.nodeStream("nodebuffer") as Readable;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      stream.destroy();
      reject(
        error instanceof EpubError
          ? error
          : new EpubError("not_epub", "This EPUB is damaged and could not be unpacked.", {
              cause: error,
            }),
      );
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) fail(unsafe("it would unpack to too much data"));
      else chunks.push(chunk);
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/** UTF-8 (BOM stripped) or UTF-16 with a BOM. Anything else is read as UTF-8. */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le").slice(1);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
