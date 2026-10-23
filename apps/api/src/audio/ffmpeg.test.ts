import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessRunner, RunResult } from "../process.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { hasBinary } from "../testing/binaries.js";
import {
  buildConcatArgs,
  buildEncodeArgs,
  concatList,
  concatWebm,
  encodeWebm,
  EncodeError,
  lastProgressSeconds,
} from "./ffmpeg.js";

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: Buffer.alloc(0),
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

async function* oneAndThreeSeconds() {
  yield Buffer.alloc(22050);
  yield Buffer.alloc(22050 * 3);
}

const options = (run: ProcessRunner) => ({ ffmpegBin: "ffmpeg", bitrate: "32k", run });

const missingBinary: ProcessRunner = async () => {
  throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
};
const timedOut: ProcessRunner = async () => result({ code: null, timedOut: true });
const aborted: ProcessRunner = async () => result({ code: null, aborted: true });
const failing: ProcessRunner = async (_cmd, args) => {
  fs.writeFileSync(args.at(-1) as string, "partial");
  return result({ code: 1, stderr: "Error initializing the muxer" });
};

describe("buildEncodeArgs", () => {
  it("reads s16le mono PCM from stdin and writes Opus in WebM", () => {
    const args = buildEncodeArgs({ sampleRate: 22050, bitrate: "32k", outputPath: "/tmp/out.tmp" });

    expect(args.join(" ")).toBe(
      "-hide_banner -loglevel error -f s16le -ar 22050 -ac 1 -i pipe:0 -af volume=-2dB -c:a libopus -b:a 32k " +
        "-application voip -ar 24000 -ac 1 -f webm -y /tmp/out.tmp",
    );
  });

  it("passes the output path as a single argument, whatever it contains", () => {
    const args = buildEncodeArgs({ sampleRate: 1, bitrate: "32k", outputPath: "/a b/$(x);c" });

    expect(args.at(-1)).toBe("/a b/$(x);c");
  });
});

describe("encodeWebm", () => {
  let dir: string;
  const pcm = { sampleRate: 22050, samples: Buffer.alloc(44100) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pipes the PCM in and renames the finished temp file into place", async () => {
    const out = path.join(dir, "01.webm");
    let seen: { args: readonly string[]; input: unknown } | undefined;
    const run: ProcessRunner = async (_cmd, args, opts) => {
      seen = { args, input: opts.input };
      fs.writeFileSync(args.at(-1) as string, "webm bytes");
      return result();
    };

    const encoded = await encodeWebm(pcm, out, options(run));

    expect(encoded.durationSeconds).toBe(1);
    expect(fs.readFileSync(out, "utf8")).toBe("webm bytes");
    expect(seen?.input).toBe(pcm.samples);
    expect(seen?.args.at(-1)).not.toBe(out); // ffmpeg wrote to a temp file
    expect(fs.readdirSync(dir)).toEqual(["01.webm"]);
  });

  it("streams chunks without joining them and measures the length from what went through", async () => {
    const out = path.join(dir, "01.webm");
    let received = 0;
    const run: ProcessRunner = async (_cmd, args, opts) => {
      expect(Buffer.isBuffer(opts.input)).toBe(false);
      for await (const chunk of opts.input as AsyncIterable<Buffer>) received += chunk.length;
      fs.writeFileSync(args.at(-1) as string, "webm bytes");
      return result();
    };
    const encoded = await encodeWebm(
      { sampleRate: 22050, samples: oneAndThreeSeconds() },
      out,
      options(run),
    );

    expect(received).toBe(22050 * 4);
    expect(encoded.durationSeconds).toBe(2);
  });

  it("leaves no file behind and keeps the old one when ffmpeg fails", async () => {
    const out = path.join(dir, "01.webm");
    fs.writeFileSync(out, "old audio");

    await expect(encodeWebm(pcm, out, options(failing))).rejects.toMatchObject({
      message: "The audio could not be encoded.", // short and safe to show
      detail: expect.stringMatching(/code 1.*muxer/), // technical, logged only
    });

    expect(fs.readFileSync(out, "utf8")).toBe("old audio");
    expect(fs.readdirSync(dir)).toEqual(["01.webm"]);
  });

  it("explains a missing ffmpeg binary", async () => {
    await expect(encodeWebm(pcm, path.join(dir, "a.webm"), options(missingBinary))).rejects.toThrow(
      /ffmpeg is not installed/,
    );
  });

  it("reports timeouts and cancellation", async () => {
    await expect(encodeWebm(pcm, path.join(dir, "a.webm"), options(timedOut))).rejects.toThrow(
      /too long/,
    );
    await expect(
      encodeWebm(pcm, path.join(dir, "a.webm"), options(aborted)),
    ).rejects.toBeInstanceOf(EncodeError);
  });
});

const progress = (seconds: number) =>
  Buffer.from(`out_time_us=1000\nout_time_us=${Math.round(seconds * 1e6)}\nprogress=end\n`);

const failingMuxer: ProcessRunner = async (_cmd, args) => {
  fs.writeFileSync(args.at(-1) as string, "partial");
  return result({ code: 1, stderr: "Error while demuxing" });
};

describe("concatWebm", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "concat-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the packets of the listed files into one file and reads the length from the progress report", async () => {
    const out = path.join(dir, "01.webm");
    let seen: { args: readonly string[]; list: string } | undefined;
    const run: ProcessRunner = async (_cmd, args) => {
      const listPath = args[args.indexOf("-i") + 1] as string;
      seen = { args, list: fs.readFileSync(listPath, "utf8") };
      fs.writeFileSync(args.at(-1) as string, "joined");
      return result({ stdout: progress(61.5) });
    };

    const joined = await concatWebm(["/a/00000.webm", "/a/00001.webm"], out, options(run));

    expect(joined.durationSeconds).toBe(61.5);
    expect(fs.readFileSync(out, "utf8")).toBe("joined");
    expect(seen?.list).toBe("file '/a/00000.webm'\nfile '/a/00001.webm'\n");
    expect(seen?.args).toContain("copy"); // nothing is encoded twice
    expect(seen?.args.at(-1)).not.toBe(out); // written to a temp file first
    expect(fs.readdirSync(dir)).toEqual(["01.webm"]); // list and temp are gone
  });

  const silentProgress: ProcessRunner = async (_cmd, args) => {
    fs.writeFileSync(args.at(-1) as string, "joined");
    return result({ stdout: Buffer.from("out_time_us=N/A\nprogress=end\n") });
  };

  it("takes the summed chunk lengths when ffmpeg does not report the length", async () => {
    const out = path.join(dir, "01.webm");

    const joined = await concatWebm(["/a.webm"], out, options(silentProgress), undefined, 12.25);

    expect(joined.durationSeconds).toBe(12.25);
    expect(fs.readFileSync(out, "utf8")).toBe("joined");
  });

  it("fails, leaving nothing behind, when neither ffmpeg nor the chunks give a length", async () => {
    const out = path.join(dir, "01.webm");

    for (const fallback of [undefined, null, 0]) {
      await expect(
        concatWebm(["/a.webm"], out, options(silentProgress), undefined, fallback),
      ).rejects.toMatchObject({ name: "EncodeError", message: expect.stringContaining("length") });
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("leaves nothing behind and keeps the old file when ffmpeg fails", async () => {
    const out = path.join(dir, "01.webm");
    fs.writeFileSync(out, "old audio");
    const run = failingMuxer;

    await expect(concatWebm(["/a.webm"], out, options(run))).rejects.toMatchObject({
      message: "The audio could not be encoded.",
      detail: expect.stringMatching(/code 1.*demuxing/),
    });

    expect(fs.readdirSync(dir)).toEqual(["01.webm"]);
    expect(fs.readFileSync(out, "utf8")).toBe("old audio");
  });

  it("reports a missing binary, a timeout and a cancel", async () => {
    const out = path.join(dir, "a.webm");

    await expect(concatWebm(["/a.webm"], out, options(missingBinary))).rejects.toThrow(
      /not installed/,
    );
    await expect(concatWebm(["/a.webm"], out, options(timedOut))).rejects.toThrow(/too long/);
    await expect(concatWebm(["/a.webm"], out, options(aborted))).rejects.toBeInstanceOf(
      EncodeError,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("concat helpers", () => {
  it("builds the arguments for joining without re-encoding", () => {
    expect(buildConcatArgs({ listPath: "/l.list", outputPath: "/o.tmp" }).join(" ")).toBe(
      "-hide_banner -loglevel error -nostats -progress pipe:1 -f concat -safe 0 -i /l.list -c copy -f webm -y /o.tmp",
    );
  });

  it("quotes file names the way the concat demuxer reads them", () => {
    expect(concatList(["/data/it's here/00000.webm"])).toBe(
      "file '/data/it'\\''s here/00000.webm'\n",
    );
  });

  it("writes absolute paths, which the demuxer needs, whatever it was given", () => {
    expect(concatList(["chunks/00000.webm"])).toBe(`file '${path.resolve("chunks/00000.webm")}'\n`);
  });

  it("takes the last progress line as the length", () => {
    expect(
      lastProgressSeconds("out_time_us=5000000\nprogress=continue\nout_time_us=7250000\n"),
    ).toBe(7.25);
    expect(lastProgressSeconds("nothing here")).toBeNull();
    expect(lastProgressSeconds("out_time_us=N/A\nprogress=end\n")).toBeNull();
    expect(lastProgressSeconds("out_time_us=0\n")).toBeNull();
  });
});

// Needs a real ffmpeg: skipped on hosts without it, runs in the Docker image.
describe.skipIf(!hasBinary("ffmpeg"))("encodeWebm with ffmpeg", () => {
  it("writes a mono Opus WebM file of the right length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-real-"));
    try {
      const session = await new FakeEngine().open("fake-en");
      const pcm = await session.synthesize("x".repeat(150));
      const out = path.join(dir, "01.webm");

      const { durationSeconds } = await encodeWebm(pcm, out, {
        ffmpegBin: "ffmpeg",
        bitrate: "32k",
      });

      const head = fs.readFileSync(out).subarray(0, 4);
      expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML header
      expect(durationSeconds).toBeCloseTo(10, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("joins separately encoded chunks into one file of the summed length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-real-"));
    try {
      const session = await new FakeEngine().open("fake-en");
      const files: string[] = [];
      for (let i = 0; i < 3; i++) {
        const pcm = await session.synthesize("x".repeat(60 + i * 30));
        const file = path.join(dir, `0000${i}.webm`);
        await encodeWebm(pcm, file, { ffmpegBin: "ffmpeg", bitrate: "32k" });
        files.push(file);
      }
      const out = path.join(dir, "joined.webm");

      const { durationSeconds } = await concatWebm(files, out, {
        ffmpegBin: "ffmpeg",
        bitrate: "32k",
      });

      expect([...fs.readFileSync(out).subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(durationSeconds).toBeCloseTo(4 + 6 + 8, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
