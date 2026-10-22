import { describe, expect, it } from "vitest";
import {
  buildCoverConvertArgs,
  buildM4bArgs,
  buildPacketsArgs,
  buildProbeArgs,
  buildTagArgs,
  packetLineEnd,
  ProgressReader,
} from "./commands.js";

const m4b = {
  listPath: "/w/l.list",
  metadataPath: "/w/m.txt",
  bitrate: "64k",
  outputPath: "/w/o.m4b",
};

describe("buildM4bArgs", () => {
  it("encodes mono AAC at the given bitrate into an M4A-brand MP4 with chapters from the metadata file", () => {
    const args = buildM4bArgs({ ...m4b, coverPath: null });

    expect(args.join(" ")).toBe(
      "-nostdin -hide_banner -loglevel error -nostats -protocol_whitelist file -progress pipe:1 -f concat -safe 0 -i /w/l.list " +
        "-f ffmetadata -i /w/m.txt -map 0:a -map_metadata 1 -map_chapters 1 " +
        "-c:a aac -b:a 64k -ac 1 -f ipod -movflags +faststart -y /w/o.m4b",
    );
    expect(args).not.toContain("-map 1:v");
  });

  it("attaches the cover as a picture without re-encoding it, and reads metadata from the third input", () => {
    const args = buildM4bArgs({ ...m4b, coverPath: "/w/cover.jpg" });

    expect(args.join(" ")).toBe(
      "-nostdin -hide_banner -loglevel error -nostats -protocol_whitelist file -progress pipe:1 -f concat -safe 0 -i /w/l.list -f jpeg_pipe -i /w/cover.jpg " +
        "-f ffmetadata -i /w/m.txt -map 0:a -map 1:v -map_metadata 2 -map_chapters 2 " +
        "-c:a aac -b:a 64k -ac 1 -c:v copy -disposition:v:0 attached_pic -f ipod -movflags +faststart -y /w/o.m4b",
    );
  });

  it("passes paths with spaces and shell characters as single arguments", () => {
    const args = buildM4bArgs({ ...m4b, listPath: "/a b/$(x);c.list", coverPath: "/a b/it's.png" });

    expect(args).toContain("/a b/$(x);c.list");
    expect(args).toContain("/a b/it's.png");
  });
});

describe("buildTagArgs", () => {
  const base = {
    inputPath: "/in.webm",
    outputPath: "/out.webm",
    title: "Chapter; one=1",
    artist: "Ann",
    album: "Book",
    track: 3,
  };

  it("copies the audio and sets only the wanted tags", () => {
    expect(buildTagArgs(base).join("|")).toBe(
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-protocol_whitelist",
        "file",
        "-i",
        "/in.webm",
        "-map",
        "0:a",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-c",
        "copy",
        "-metadata",
        "title=Chapter; one=1",
        "-metadata",
        "artist=Ann",
        "-metadata",
        "album=Book",
        "-metadata",
        "track=3",
        "-f",
        "webm",
        "-y",
        "/out.webm",
      ].join("|"),
    );
  });

  it("does not re-encode and carries no cover", () => {
    const args = buildTagArgs(base);

    expect(args).toContain("copy");
    expect(args).not.toContain("-c:a");
    expect(args).not.toContain("1:v");
  });

  it("leaves the artist out when the author is unknown, and keeps a value with a line break whole", () => {
    const args = buildTagArgs({ ...base, artist: null, title: "a\nb" });

    expect(args.some((arg) => arg.startsWith("artist="))).toBe(false);
    expect(args).toContain("title=a\nb");
  });
});

describe("other commands", () => {
  it("probes the length and the audio stream as JSON", () => {
    expect(buildProbeArgs("/c.webm")).toEqual([
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,channels",
      "-of",
      "json",
      "/c.webm",
    ]);
  });

  it("converts a cover to a JPEG of one frame, at most 1400 px wide, in a pixel format every player reads", () => {
    const args = buildCoverConvertArgs("png_pipe", "/c.png", "/c.jpg").join(" ");

    expect(args).toContain("-frames:v 1");
    expect(args).toContain("scale='min(1400,iw)':-2");
    expect(args).toContain("-pix_fmt yuvj420p");
    expect(args.endsWith("-f mjpeg -y /c.jpg")).toBe(true);
  });

  it("tells ffmpeg which one format the cover may be, takes no input from the terminal, allows only files and caps the pixels", () => {
    const args = buildCoverConvertArgs("webp_pipe", "/c.bin", "/c.jpg");

    // The format flag belongs to the input: it comes right before `-i`, with the pixel cap.
    expect(args.slice(args.indexOf("-f"), args.indexOf("-i") + 2)).toEqual([
      "-f",
      "webp_pipe",
      "-max_pixels",
      "50000000",
      "-i",
      "/c.bin",
    ]);
    expect(args.slice(0, 7)).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-protocol_whitelist",
      "file",
    ]);
  });

  it("gives every ffmpeg and ffprobe call the same safety flags", () => {
    const whitelisted = [
      buildM4bArgs({ ...m4b, coverPath: null }),
      buildTagArgs({
        inputPath: "/i",
        outputPath: "/o",
        title: "t",
        artist: null,
        album: "a",
        track: 1,
      }),
      buildProbeArgs("/c"),
      buildPacketsArgs("/c", 1),
    ];
    for (const args of whitelisted) {
      expect(
        args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2),
      ).toEqual(["-protocol_whitelist", "file"]);
    }
  });
});

describe("packets", () => {
  it("reads the packets from a point near the end of the file, of the first audio stream", () => {
    expect(buildPacketsArgs("/c.webm", 113.6071)).toEqual([
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-read_intervals",
      "113.607%",
      "-select_streams",
      "a:0",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "csv=p=0",
      "/c.webm",
    ]);
    expect(buildPacketsArgs("/c.webm", -3)).toContain("0.000%");
  });

  it("takes the end of the audio from a packet line: start plus length", () => {
    expect(packetLineEnd("118.607000,0.020000,")).toBeCloseTo(118.627, 6);
  });

  it("is null when the line is not a packet", () => {
    expect(packetLineEnd("")).toBeNull();
    expect(packetLineEnd("N/A,N/A,")).toBeNull();
    expect(packetLineEnd("[matroska,webm @ 0x1] File ended prematurely")).toBeNull();
  });
});

describe("ProgressReader", () => {
  it("reads the encoded length as it streams in, even when a line is cut in two", () => {
    const reader = new ProgressReader();

    expect(reader.feed(Buffer.from("frame=1\nout_time_us=1500"))).toBe(0);
    expect(reader.feed(Buffer.from("000\nprogress=continue\nout_time_us=42"))).toBe(1.5);
    expect(reader.feed(Buffer.from("000000\nprogress=end\n"))).toBe(42);
    expect(reader.seconds).toBe(42);
  });

  it("ignores N/A", () => {
    const reader = new ProgressReader();

    expect(
      reader.feed(Buffer.from("out_time_us=N/A\nout_time_us=2000000\nout_time_us=N/A\n")),
    ).toBe(2);
  });
});
