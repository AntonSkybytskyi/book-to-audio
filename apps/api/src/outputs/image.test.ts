import { describe, expect, it } from "vitest";
import {
  app,
  gif,
  jpeg,
  png,
  riff,
  u16be,
  webpExtended,
  webpLossless,
  webpLossy,
} from "../testing/images.js";
import { hasSaneSize, INPUT_FORMAT, MAX_PIXELS, readImageInfo } from "./image.js";

describe("readImageInfo", () => {
  it("reads a PNG from its IHDR", () => {
    expect(readImageInfo(png(300, 450))).toEqual({ format: "png", width: 300, height: 450 });
  });

  it("reads a JPEG from the first frame header, past EXIF and profile blocks", () => {
    expect(readImageInfo(jpeg(1200, 800))).toEqual({ format: "jpeg", width: 1200, height: 800 });
    expect(readImageInfo(jpeg(640, 480, 0xc2, [app(70_000 & 0xffff), app(3000)]))).toEqual({
      format: "jpeg",
      width: 640,
      height: 480,
    });
  });

  it("does not take a huffman table (C4) or an arithmetic conditioning marker for the frame", () => {
    const tables = Buffer.concat([Buffer.from([0xff, 0xc4]), u16be(6), Buffer.alloc(4)]);
    expect(readImageInfo(jpeg(10, 20, 0xc0, [tables]))).toEqual({
      format: "jpeg",
      width: 10,
      height: 20,
    });
    expect(readImageInfo(jpeg(10, 20, 0xc4))).toBeNull();
  });

  it("gives up on a JPEG with no frame header, a broken segment length, or one that runs off the end", () => {
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0]))).toBeNull();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0, 0, 0, 0]))).toBeNull();
    expect(readImageInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), app(40)]))).toBeNull();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0]))).toBeNull();
  });

  it("reads a GIF from its logical screen, GIF87a and GIF89a only", () => {
    expect(readImageInfo(gif(90, 60))).toEqual({ format: "gif", width: 90, height: 60 });
    expect(readImageInfo(gif(90, 60, "GIF87a"))).toEqual({ format: "gif", width: 90, height: 60 });
    expect(readImageInfo(gif(90, 60, "GIF88a"))).toBeNull();
    expect(readImageInfo(gif(90, 60, "GIF89b"))).toBeNull();
    expect(readImageInfo(gif(90, 60, "gif89a"))).toBeNull();
  });

  it("reads WebP of all three kinds", () => {
    expect(readImageInfo(webpLossy(300, 450))).toEqual({ format: "webp", width: 300, height: 450 });
    expect(readImageInfo(webpLossless(301, 451))).toEqual({
      format: "webp",
      width: 301,
      height: 451,
    });
    expect(readImageInfo(webpExtended(70_000 & 0xffffff, 3))).toEqual({
      format: "webp",
      width: 70_000,
      height: 3,
    });
  });

  it("rejects a WebP with a wrong start code, signature or chunk", () => {
    const lossy = webpLossy(10, 10);
    lossy[23] = 0;
    expect(readImageInfo(lossy)).toBeNull();
    const lossless = webpLossless(10, 10);
    lossless[20] = 0;
    expect(readImageInfo(lossless)).toBeNull();
    expect(readImageInfo(riff("ALPH", Buffer.alloc(20)))).toBeNull();
  });

  it("knows nothing else: text, a transport stream, an MPEG-TS-like blob, a playlist, empty input", () => {
    expect(readImageInfo(Buffer.from("#EXTM3U\n#EXTINF:1,x\nfile:///etc/hostname\n"))).toBeNull();
    expect(
      readImageInfo(Buffer.concat([Buffer.from([0x47, 0x40, 0x11, 0x10]), Buffer.alloc(200)])),
    ).toBeNull();
    expect(readImageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(readImageInfo(Buffer.alloc(0))).toBeNull();
    expect(readImageInfo(png(1, 1).subarray(0, 12))).toBeNull();
  });

  it("is not fooled by a PNG signature with a different first chunk", () => {
    const bad = png(10, 10);
    bad.write("IDAT", 12, "latin1");
    expect(readImageInfo(bad)).toBeNull();
  });

  it("reads a GIF header followed by MPEG-TS-like bytes as the GIF it claims to be, with a size nobody would accept", () => {
    const blob = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.from([0x47, 0x40, 0x11, 0x10]),
      Buffer.alloc(400, 0x47),
    ]);

    const info = readImageInfo(blob);

    expect(info).toEqual({ format: "gif", width: 0x4047, height: 0x1011 });
    expect(hasSaneSize(info as NonNullable<typeof info>)).toBe(false);
  });
});

const info = (width: number, height: number) => ({ format: "png" as const, width, height });

describe("hasSaneSize", () => {
  it("accepts ordinary and large covers", () => {
    expect(hasSaneSize(info(300, 450))).toBe(true);
    expect(hasSaneSize(info(7000, 7000))).toBe(true);
  });

  it("rejects an empty picture and a decompression bomb", () => {
    expect(hasSaneSize(info(0, 450))).toBe(false);
    expect(hasSaneSize(info(300, 0))).toBe(false);
    expect(hasSaneSize(info(65_535, 65_535))).toBe(false);
    expect(hasSaneSize(info(MAX_PIXELS, 2))).toBe(false);
    expect(hasSaneSize(readImageInfo(png(4_000_000_000, 4_000_000_000)) as never)).toBe(false);
  });
});

describe("INPUT_FORMAT", () => {
  it("names an ffmpeg demuxer that decodes only that kind of picture", () => {
    expect(INPUT_FORMAT).toEqual({
      png: "png_pipe",
      jpeg: "jpeg_pipe",
      gif: "gif",
      webp: "webp_pipe",
    });
  });
});
