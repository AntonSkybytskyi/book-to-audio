// Headers of pictures, just enough for `readImageInfo`: the bytes after the header are zeros.

const u32be = (n: number) =>
  Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const u16be = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const u16le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);

export const png = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13),
    Buffer.from("IHDR"),
    u32be(width),
    u32be(height),
    Buffer.alloc(20),
  ]);

/** A JPEG with some segments before the frame header, the way real files have EXIF and a profile. */
export const jpeg = (width: number, height: number, marker = 0xc0, before: Buffer[] = []) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...before,
    Buffer.from([0xff, marker]),
    u16be(17),
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.alloc(20),
  ]);

export const app = (bytes: number) =>
  Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(bytes + 2), Buffer.alloc(bytes)]);

export const gif = (width: number, height: number, magic = "GIF89a") =>
  Buffer.concat([Buffer.from(magic, "latin1"), u16le(width), u16le(height), Buffer.alloc(20)]);

export const riff = (chunk: string, body: Buffer) =>
  Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.from(chunk, "latin1"),
    Buffer.alloc(4),
    body,
  ]);

export const webpLossy = (width: number, height: number) =>
  riff(
    "VP8 ",
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]),
      u16le(width),
      u16le(height),
      Buffer.alloc(10),
    ]),
  );

export const webpLossless = (width: number, height: number) => {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const field = Buffer.alloc(4);
  field.writeUInt32LE(bits >>> 0);
  return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), field, Buffer.alloc(10)]));
};

export const webpExtended = (width: number, height: number) => {
  const w = width - 1;
  const h = height - 1;
  return riff(
    "VP8X",
    Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([w & 255, (w >> 8) & 255, (w >> 16) & 255]),
      Buffer.from([h & 255, (h >> 8) & 255, (h >> 16) & 255]),
      Buffer.alloc(10),
    ]),
  );
};
