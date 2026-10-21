import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessRunner, RunResult } from "../process.js";
import { FakeEngine } from "../tts/fake.js";
import { hasBinary } from "../testing/binaries.js";
import { buildEncodeArgs, encodeWebm, EncodeError, pcmDurationSeconds } from "./ffmpeg.js";

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: Buffer.alloc(0),
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

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

describe("pcmDurationSeconds", () => {
  it("divides samples by the sample rate", () => {
    expect(pcmDurationSeconds({ sampleRate: 1000, channels: 1, samples: Buffer.alloc(3000) })).toBe(
      1.5,
    );
  });
});

describe("encodeWebm", () => {
  let dir: string;
  const pcm = { sampleRate: 22050, channels: 1 as const, samples: Buffer.alloc(44100) };

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

// Needs a real ffmpeg: skipped on hosts without it, runs in the Docker image.
describe.skipIf(!hasBinary("ffmpeg"))("encodeWebm with ffmpeg", () => {
  it("writes a mono Opus WebM file of the right length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-real-"));
    try {
      const pcm = await new FakeEngine().synthesize({
        text: "x".repeat(150),
        voiceId: "fake-en",
        speed: 1,
      });
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
});
