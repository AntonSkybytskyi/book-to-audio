/**
 * What kind of picture a cover file is and how big, read from its header in Node. The EPUB is
 * untrusted, and ffmpeg guesses a file's format from its content, so nothing is handed to ffmpeg
 * before this has said it is a PNG, JPEG, GIF or WebP of a sane size, and ffmpeg is then told which
 * format to expect rather than left to guess.
 */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

/** About 7000 x 7000. A decoded picture is 3 to 4 bytes a pixel, so this is at most about 200 MB of memory. */
export const MAX_PIXELS = 50_000_000;
/** How much of the file is read to find the size: the JPEG size marker can follow large EXIF and colour profile blocks. */
export const HEADER_BYTES = 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The ffmpeg input format that decodes only this kind of picture. */
export const INPUT_FORMAT: Record<ImageFormat, string> = {
  png: "png_pipe",
  jpeg: "jpeg_pipe",
  gif: "gif",
  webp: "webp_pipe",
};

/** The format and size from the first bytes of a file, or null when it is not one of the four or the header does not parse. */
export function readImageInfo(head: Buffer): ImageInfo | null {
  if (head.length >= 24 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(head);
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return readJpeg(head);
  }
  const magic = head.subarray(0, 6).toString("latin1");
  if (head.length >= 10 && (magic === "GIF87a" || magic === "GIF89a")) {
    return { format: "gif", width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (
    head.length >= 30 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return readWebp(head);
  }
  return null;
}

/** True when the picture is not empty and has at most `MAX_PIXELS` pixels. */
export const hasSaneSize = ({ width, height }: ImageInfo): boolean =>
  width > 0 && height > 0 && width * height <= MAX_PIXELS;

function readPng(head: Buffer): ImageInfo | null {
  // The first chunk must be IHDR: 4 bytes of length, "IHDR", then width and height.
  if (head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { format: "png", width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// Start-of-frame markers carry the size; C4 (huffman tables), C8 (reserved) and CC (arithmetic conditioning) do not.
const isFrameMarker = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function readJpeg(head: Buffer): ImageInfo | null {
  let at = 2;
  while (at + 4 <= head.length) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1] as number;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Markers with no length: standalone (01, D0 to D7) and start/end of image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      at += 2;
      continue;
    }
    if (marker === 0xda) return null; // image data starts and no frame header came first
    const length = head.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (isFrameMarker(marker)) {
      if (at + 9 > head.length) return null;
      return {
        format: "jpeg",
        height: head.readUInt16BE(at + 5),
        width: head.readUInt16BE(at + 7),
      };
    }
    at += 2 + length;
  }
  return null;
}

function readWebp(head: Buffer): ImageInfo | null {
  const chunk = head.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ") {
    // Lossy: a 3 byte frame tag, the start code 9D 01 2A, then 14 bit width and height.
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
    return {
      format: "webp",
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    // Lossless: signature byte 2F, then width-1 and height-1 as 14 bit fields.
    if (head[20] !== 0x2f) return null;
    const bits = head.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // Extended: canvas width-1 and height-1 as 24 bit fields.
    return {
      format: "webp",
      width: (head[24] as number) + ((head[25] as number) << 8) + ((head[26] as number) << 16) + 1,
      height: (head[27] as number) + ((head[28] as number) << 8) + ((head[29] as number) << 16) + 1,
    };
  }
  return null;
}
