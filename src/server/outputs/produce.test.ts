import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "../books/storage.js";
import type { ProcessRunner, RunOptions, RunResult } from "../process.js";
import { BuildCancelled, NO_SPACE_MESSAGE, OutputError } from "./errors.js";
import { gif, jpeg, png, webpLossy } from "../testing/images.js";
import { until } from "../testing/pool-harness.js";
import { createOutputProducer, type OutputJob, type ProducerOptions } from "./produce.js";

interface Call {
  command: string;
  args: readonly string[];
}

const done = (overrides: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: Buffer.alloc(0),
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

/** What the fake ffprobe says about a file, by path; anything else is "cannot be read". */
interface Probed {
  duration?: number;
  /** Where the last packet really ends; the header duration unless the file is cut short. */
  end?: number;
  codec?: string;
  channels?: number;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const room = async () => 200 * 1024 ** 2;

const missing: ProcessRunner = async () => {
  throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
};

describe("createOutputProducer", () => {
  let root: string;
  let storage: Storage;
  let calls: Call[];
  let probed: Map<string, Probed>;
  let encodedSeconds: number | null;
  let m4bFailure: Partial<RunResult> | null;
  let warnings: string[];
  let progress: number[];

  /** The fake ffprobe and ffmpeg: they look at the arguments the way the real ones would. */
  const run: ProcessRunner = async (command, args, options: RunOptions) => {
    calls.push({ command, args });
    const input = (flag = "-i") => args[args.indexOf(flag) + 1] as string;
    if (command === "ffprobe") {
      const file = args.at(-1) as string;
      const info = probed.get(file);
      if (!info) return done({ code: 1, stderr: "No such file" });
      if (args.includes("packet=pts_time,duration_time")) {
        const end = info.end ?? info.duration ?? 10;
        const text = `${(end - 0.04).toFixed(6)},0.020000,\n${(end - 0.02).toFixed(6)},0.020000,\n`;
        // Streamed, not collected, like the real runner does when it is given a listener.
        options.onStdout?.(Buffer.from(text));
        return done();
      }
      return done({
        stdout: Buffer.from(
          JSON.stringify({
            format: { duration: String(info.duration ?? 10) },
            streams: [
              {
                codec_type: "audio",
                codec_name: info.codec ?? "opus",
                channels: info.channels ?? 1,
              },
            ],
          }),
        ),
      });
    }
    const output = args.at(-1) as string;
    const bin = command === "nice" ? args[2] : command;
    expect(bin).toBe("ffmpeg");
    if (args.includes("ipod")) {
      if (m4bFailure) return done(m4bFailure);
      fs.writeFileSync(output, "m4b bytes");
      const total = encodedSeconds ?? probedTotal();
      options.onStdout?.(Buffer.from(`out_time_us=${Math.round((total / 2) * 1e6)}\n`));
      options.onStdout?.(Buffer.from(`out_time_us=${Math.round(total * 1e6)}\nprogress=end\n`));
      return done();
    }
    if (args.includes("mjpeg")) {
      fs.writeFileSync(output, "converted jpeg");
      return done();
    }
    // The tagging remux.
    fs.writeFileSync(output, `tagged ${path.basename(input())}`);
    return done();
  };

  const encodeCall = () => calls.find((c) => c.args.includes("ipod"));
  const convertCall = () => calls.find((c) => c.args.includes("mjpeg"));
  const coverFile = (content: Buffer) => withCover("cover.img", content);
  const failingCover: ProcessRunner = async (command, args, options) =>
    args.includes("mjpeg")
      ? done({ code: 1, stderr: "Invalid data" })
      : run(command, args, options);

  const slow: ProcessRunner = async (command, args, options) =>
    args.includes("ipod") ? done({ code: null, timedOut: true }) : run(command, args, options);

  const withCover = async (file: string, content: Buffer | string = "image") => {
    const rel = path.join("books", "b", file);
    fs.mkdirSync(storage.bookDir("b"), { recursive: true });
    fs.writeFileSync(storage.resolve(rel), content);
    return rel;
  };

  const probedTotal = () => [...probed.values()].reduce((sum, p) => sum + (p.duration ?? 10), 0);

  const make = (extra: Partial<ProducerOptions> = {}) =>
    createOutputProducer({
      storage,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      m4bBitrate: "64k",
      run,
      logger: { warn: (_context, message) => warnings.push(message) },
      ...extra,
    });

  /** Adds chapters with files on disk; the probe length defaults to the recorded one. */
  const chapters = (titles: string[], recorded = 10) =>
    titles.map((title, index) => {
      const position = index + 1;
      const audioPath = storage.audioRelPath("b", position);
      fs.writeFileSync(storage.resolve(audioPath), `audio ${position}`);
      probed.set(storage.resolve(audioPath), { duration: recorded });
      return { position, title, audioPath, durationSeconds: recorded };
    });

  const job = (
    list: ReturnType<typeof chapters>,
    overrides: Partial<OutputJob> = {},
    book: Partial<OutputJob["book"]> = {},
  ): OutputJob => {
    const workDir = path.join(root, "work");
    fs.mkdirSync(workDir, { recursive: true });
    return {
      book: { id: "b", title: "Book", author: "Ann", coverPath: null, ...book },
      chapters: list,
      workDir,
      signal: new AbortController().signal,
      onProgress: (fraction) => progress.push(fraction),
      ...overrides,
    };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "produce-test-"));
    storage = new Storage(path.join(root, "data"));
    storage.ensureAudioDir("b");
    calls = [];
    probed = new Map();
    encodedSeconds = null;
    m4bFailure = null;
    warnings = [];
    progress = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lays the chapter markers out from the lengths ffprobe reports, not the recorded ones", async () => {
    const list = chapters(["One", "Two", "Three"]);
    probed.set(storage.resolve(list[0]?.audioPath as string), { duration: 7.378 });
    probed.set(storage.resolve(list[1]?.audioPath as string), { duration: 14.381 });
    probed.set(storage.resolve(list[2]?.audioPath as string), { duration: 10.02 });
    // The database says 7.36 s for chapter one; the file is 7.378 s (within tolerance).
    list[0]!.durationSeconds = 7.36;
    list[1]!.durationSeconds = 14.38;
    list[2]!.durationSeconds = 10.02;
    const input = job(list);

    await make().produce(input);

    const metadata = fs.readFileSync(path.join(input.workDir, "metadata.txt"), "utf8");
    expect(metadata).toContain("START=0\nEND=7378\ntitle=One");
    expect(metadata).toContain("START=7378\nEND=21759\ntitle=Two");
    expect(metadata).toContain("START=21759\nEND=31779\ntitle=Three");
    expect(metadata).toContain("title=Book\nartist=Ann\nalbum=Book\n");
  });

  it("joins the chapter files in order by absolute path", async () => {
    const list = chapters(["A", "B"]);
    const input = job(list);

    await make().produce(input);

    expect(fs.readFileSync(path.join(input.workDir, "chapters.list"), "utf8")).toBe(
      `file '${storage.resolve("audio/b/01.webm")}'\nfile '${storage.resolve("audio/b/02.webm")}'\n`,
    );
  });

  it("returns an M4B and a ZIP with one tagged, numbered, STORE entry per chapter", async () => {
    const list = chapters(["Глава: перша", "Second / part", "Third"]);

    const built = await make().produce(job(list));

    expect(fs.readFileSync(built.m4bPath, "utf8")).toBe("m4b bytes");
    const zip = await JSZip.loadAsync(fs.readFileSync(built.zipPath));
    expect(Object.keys(zip.files)).toEqual([
      "01 - Глава перша.webm",
      "02 - Second part.webm",
      "03 - Third.webm",
    ]);
    const tagCalls = calls.filter((c) => c.args.includes("webm"));
    expect(tagCalls).toHaveLength(3);
    expect(tagCalls[1]?.args).toEqual(
      expect.arrayContaining([
        "title=Second / part",
        "artist=Ann",
        "album=Book",
        "track=2",
        "copy",
      ]),
    );
  });

  it("runs the M4B encode at a low priority and the quick jobs normally", async () => {
    const list = chapters(["A"]);

    await make({ niceBin: "nice" }).produce(job(list));

    const encode = calls.find((c) => c.args.includes("ipod"));
    expect(encode?.command).toBe("nice");
    expect(encode?.args.slice(0, 3)).toEqual(["-n", "10", "ffmpeg"]);
    expect(calls.filter((c) => c.command === "nice")).toHaveLength(1);
  });

  it("runs ffmpeg directly when there is no nice", async () => {
    await make({ niceBin: null }).produce(job(chapters(["A"])));

    expect(calls.find((c) => c.args.includes("ipod"))?.command).toBe("ffmpeg");
  });

  it("reports progress that only goes up and ends at 1", async () => {
    await make().produce(job(chapters(["A", "B", "C", "D"])));

    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
    expect(progress.some((p) => p > 0.4 && p < 0.9)).toBe(true);
  });

  it("reports progress for every chapter while it checks the files", async () => {
    await make().produce(job(chapters(["A", "B", "C", "D", "E"])));

    // Five checks fill the first 5% in five steps, before the encode starts.
    const checking = progress.filter((p) => p <= 0.05);
    expect(checking.slice(0, 5).map((p) => Math.round(p * 1000))).toEqual([10, 20, 30, 40, 50]);
  });

  it("clips very long tags before they become arguments", async () => {
    const list = chapters(["Ж".repeat(2000)]);

    await make().produce(job(list, {}, { title: "T".repeat(5000), author: "A".repeat(5000) }));

    const tag = calls.find((c) => c.args.includes("webm"));
    const values = (tag?.args ?? []).filter((arg) => /^(title|artist|album)=/.test(arg));
    expect(values).toHaveLength(3);
    for (const value of values) {
      expect(Buffer.byteLength(value.slice(value.indexOf("=") + 1))).toBeLessThanOrEqual(1000);
    }
  });

  it("stops the probes of the other chapters when one chapter is bad, and reports that one", async () => {
    const list = chapters(["A", "B", "C", "D"]);
    probed.delete(storage.resolve(list[0]?.audioPath as string)); // ffprobe cannot read chapter 1
    const aborted: string[] = [];
    const waiting: ProcessRunner = async (command, args, options) => {
      const file = args.at(-1) as string;
      if (command === "ffprobe" && file !== storage.resolve(list[0]?.audioPath as string)) {
        // The other probes are still running when chapter 1 fails.
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted.push(file);
        return done({ code: null, aborted: true });
      }
      return run(command, args, options);
    };

    const error = await failure(make({ run: waiting }).produce(job(list)));

    expect(error).toMatchObject({ message: expect.stringContaining("chapter 1 cannot be read") });
    await until(() => aborted.length === 3);
  });

  describe("cover", () => {
    it.each([
      ["png", png(300, 450), "png_pipe"],
      ["jpeg", jpeg(300, 450), "jpeg_pipe"],
      ["gif", gif(300, 450), "gif"],
      ["webp", webpLossy(300, 450), "webp_pipe"],
    ] as const)(
      "always makes a new JPEG from a %s cover, read as that format only",
      async (_name, bytes, format) => {
        const coverPath = await coverFile(bytes);
        const input = job(chapters(["A"]), {}, { coverPath });

        await make().produce(input);

        const convert = convertCall();
        expect(
          convert?.args.slice(convert.args.indexOf("-f"), convert.args.indexOf("-f") + 2),
        ).toEqual(["-f", format]);
        expect(convert?.args).toContain(storage.resolve(coverPath));
        expect(convert?.args).toContain("-max_pixels");
        // The M4B gets the JPEG that was made, never the original.
        const encode = encodeCall();
        const picture = encode?.args.find((arg) =>
          arg.startsWith(path.join(input.workDir, "cover-")),
        );
        expect(picture).toMatch(/\.jpg$/);
        expect(encode?.args).not.toContain(storage.resolve(coverPath));
        expect(encode?.args).toContain("attached_pic");
        expect(fs.readFileSync(picture as string, "utf8")).toBe("converted jpeg");
      },
    );

    it("runs the conversion at a low priority too", async () => {
      const coverPath = await coverFile(png(10, 10));

      await make({ niceBin: "nice" }).produce(job(chapters(["A"]), {}, { coverPath }));

      expect(convertCall()?.command).toBe("nice");
    });

    it.each([
      ["a picture too large to decode", png(20_000, 20_000)],
      ["an empty picture", png(0, 450)],
      ["a JPEG that claims 65535 x 65535", jpeg(65_535, 65_535)],
      [
        "a GIF header followed by transport stream bytes",
        Buffer.concat([
          Buffer.from("GIF89a"),
          Buffer.from([0x47, 0x40, 0x11, 0x10]),
          Buffer.alloc(400, 0x47),
        ]),
      ],
      [
        "something that is not a picture",
        Buffer.from("#EXTM3U\n#EXTINF:1,x\nfile:///etc/hostname\n"),
      ],
      ["an unknown GIF version", gif(10, 10, "GIF88a")],
      ["an empty file", Buffer.alloc(0)],
    ])("leaves out %s and builds the audiobook without a picture", async (_name, bytes) => {
      const coverPath = await coverFile(bytes);

      await make().produce(job(chapters(["A"]), {}, { coverPath }));

      expect(calls.some((c) => c.command === "ffmpeg" && c.args.includes("-max_pixels"))).toBe(
        false,
      );
      expect(encodeCall()?.args).not.toContain("attached_pic");
      expect(warnings.join()).toMatch(/cover/);
    });

    it("leaves out a cover that ffmpeg then fails to decode", async () => {
      const coverPath = await coverFile(png(300, 450));
      await make({ run: failingCover }).produce(job(chapters(["A"]), {}, { coverPath }));

      expect(encodeCall()?.args).not.toContain("attached_pic");
      expect(warnings.join()).toMatch(/cover could not be used/);
    });

    it("does not read a cover file that is huge", async () => {
      const coverPath = path.join("books", "b", "cover.big");
      fs.mkdirSync(storage.bookDir("b"), { recursive: true });
      const handle = fs.openSync(storage.resolve(coverPath), "w");
      fs.writeSync(handle, png(10, 10));
      fs.ftruncateSync(handle, 40 * 1024 * 1024);
      fs.closeSync(handle);

      await make().produce(job(chapters(["A"]), {}, { coverPath }));

      expect(convertCall()).toBeUndefined();
      expect(warnings.join()).toMatch(/cover/);
    });

    it("builds without a picture for a book that has no cover", async () => {
      await make().produce(job(chapters(["A"])));

      expect(encodeCall()?.args).not.toContain("attached_pic");
    });
  });

  describe("a build that cannot go ahead", () => {
    it("refuses a book without chapters", async () => {
      const error = await failure(make().produce(job([])));

      expect(error).toBeInstanceOf(OutputError);
      expect(calls).toHaveLength(0);
    });

    it("names the chapter whose file is missing", async () => {
      const list = chapters(["A", "B"]);
      fs.rmSync(storage.resolve(list[1]?.audioPath as string));

      const error = await failure(make().produce(job(list)));

      expect(error).toMatchObject({
        message:
          "The audio file of chapter 2 is missing. Regenerate chapter 2, then the downloads are built again.",
      });
      expect(calls.some((c) => c.args.includes("ipod"))).toBe(false);
    });

    it("names a chapter with no recorded audio", async () => {
      const list = chapters(["A"]);
      list[0]!.audioPath = null as unknown as string;

      expect(await failure(make().produce(job(list)))).toMatchObject({
        message: expect.stringContaining("Chapter 1 has no audio."),
      });
    });

    it("rejects a file that is not mono Opus, or cannot be read", async () => {
      const list = chapters(["A", "B", "C"]);
      probed.set(storage.resolve(list[0]?.audioPath as string), { codec: "aac" });
      expect(await failure(make().produce(job(list)))).toMatchObject({
        message: expect.stringContaining("chapter 1 is not valid"),
      });

      probed.set(storage.resolve(list[0]?.audioPath as string), { channels: 2 });
      expect(await failure(make().produce(job(list)))).toMatchObject({
        message: expect.stringContaining("chapter 1 is not valid"),
      });

      probed.set(storage.resolve(list[0]?.audioPath as string), { duration: 10 });
      probed.delete(storage.resolve(list[2]?.audioPath as string));
      expect(await failure(make().produce(job(list)))).toMatchObject({
        message: expect.stringContaining("chapter 3 cannot be read"),
      });
    });

    it("catches a chapter file that is cut short although its header still has the full length", async () => {
      const list = chapters(["A", "B"]);
      probed.set(storage.resolve(list[1]?.audioPath as string), { duration: 10, end: 1.2 });

      expect(await failure(make().produce(job(list)))).toMatchObject({
        message: expect.stringContaining("chapter 2 is incomplete"),
      });
      expect(calls.some((c) => c.args.includes("ipod"))).toBe(false);
    });

    it("catches a chapter file that was replaced without the database knowing", async () => {
      const list = chapters(["A", "B"], 10);
      probed.set(storage.resolve(list[1]?.audioPath as string), { duration: 14.2 });

      const error = await failure(make().produce(job(list)));

      expect(error).toMatchObject({
        message: expect.stringMatching(
          /chapter 2 is not the one that was recorded \(14\.2 s, expected 10\.0 s\)/,
        ),
      });
    });

    it("accepts a file within the tolerance of the recorded length", async () => {
      const list = chapters(["A"], 600);
      probed.set(storage.resolve(list[0]?.audioPath as string), { duration: 600.4 });

      await expect(make().produce(job(list))).resolves.toBeDefined();
    });

    it("stops before encoding when the disk has too little room, and says so", async () => {
      const list = chapters(["A", "B"]);

      const error = await failure(make({ freeBytes: async () => 5 }).produce(job(list)));

      expect(error).toMatchObject({ message: NO_SPACE_MESSAGE });
      expect(calls.some((c) => c.args.includes("ipod"))).toBe(false);
    });

    it("keeps the margin free as well", async () => {
      const list = chapters(["A"]);

      await expect(
        make({ freeBytes: room, minFreeBytes: 100 * 1024 ** 2 }).produce(job(list)),
      ).resolves.toBeDefined();
      expect(
        await failure(make({ freeBytes: room, minFreeBytes: 300 * 1024 ** 2 }).produce(job(list))),
      ).toMatchObject({ message: NO_SPACE_MESSAGE });
    });

    it("turns a disk that fills up during the encode into the same message", async () => {
      m4bFailure = { code: 1, stderr: "av_interleaved_write_frame(): No space left on device" };

      expect(await failure(make().produce(job(chapters(["A"]))))).toMatchObject({
        message: NO_SPACE_MESSAGE,
      });
    });

    it("keeps ffmpeg's own words for the log and gives the owner a plain message", async () => {
      m4bFailure = { code: 1, stderr: "Error initializing the muxer" };

      const error = await failure(make().produce(job(chapters(["A"]))));

      expect(error).toMatchObject({ message: "The downloads could not be built." });
      expect((error as OutputError).detail).toMatch(
        /ffmpeg exited with code 1: Error initializing/,
      );
    });

    it("fails when the encoded audio is not the length of its chapters", async () => {
      encodedSeconds = 17;

      const error = await failure(make().produce(job(chapters(["A", "B"]))));

      expect(error).toMatchObject({ message: expect.stringContaining("different length") });
    });

    it("says ffmpeg is missing", async () => {
      expect(await failure(make({ run: missing }).produce(job(chapters(["A"]))))).toMatchObject({
        message: expect.stringContaining("not installed"),
      });
    });

    it("stops with BuildCancelled when the run is aborted, and leaves no zip entry half written", async () => {
      const abort = new AbortController();
      const cancelling: ProcessRunner = async (command, args, options) => {
        if (args.includes("ipod")) {
          abort.abort();
          return done({ code: null, aborted: true });
        }
        return run(command, args, options);
      };

      const error = await failure(
        make({ run: cancelling }).produce(job(chapters(["A"]), { signal: abort.signal })),
      );

      expect(error).toBeInstanceOf(BuildCancelled);
    });

    it("times out a build that takes forever", async () => {
      expect(await failure(make({ run: slow }).produce(job(chapters(["A"]))))).toMatchObject({
        message: "Building the downloads took too long.",
      });
    });
  });
});
