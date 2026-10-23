import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatWebm, encodeWebm } from "../audio/ffmpeg.js";
import { Storage } from "../books/storage.js";
import { jpeg, png } from "../testing/images.js";
import { hasBinary } from "../testing/binaries.js";
import { createOutputProducer } from "./produce.js";

const RATE = 22_050;
const encoder = { ffmpegBin: "ffmpeg", bitrate: "32k" };

/** A tone, so there is something to encode. */
const tone = (seconds: number, hz: number) => {
  const samples = Buffer.alloc(Math.round(seconds * RATE) * 2);
  for (let i = 0; i < samples.length / 2; i++) {
    samples.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2);
  }
  return samples;
};

const probe = (file: string, ...args: string[]) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-of", "json", ...args, file]).toString());

const packetsMd5 = (file: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-c", "copy", "-f", "md5", "-"])
    .toString()
    .trim();

const pictureOf = (m4bPath: string) =>
  probe(m4bPath, "-show_streams").streams.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
/** Decoding the whole file is the playback test: it prints nothing when every stream decodes. */
const playsFully = (m4bPath: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", m4bPath, "-f", "null", "-"], {
    stdio: ["ignore", "pipe", "pipe"],
  }).length === 0;

// Needs real ffmpeg and ffprobe: skipped on hosts without them, runs in the Docker image.
describe.skipIf(!hasBinary("ffmpeg") || !hasBinary("ffprobe"))(
  "createOutputProducer with ffmpeg",
  () => {
    let root: string;
    let storage: Storage;
    const titles = [
      "Plain",
      "Odd = ; # \\ chars\nand a second line",
      "Глава «Київ»: частина 1",
      "../../etc/passwd",
    ];
    const lengths = [3.37, 2.25, 4.1, 1.5];
    const chapters: {
      position: number;
      title: string;
      audioPath: string;
      durationSeconds: number;
    }[] = [];

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "produce-real-"));
      storage = new Storage(path.join(root, "data"));
      storage.ensureAudioDir("b");
      for (const [index, title] of titles.entries()) {
        const position = index + 1;
        const parts: string[] = [];
        for (const part of [0, 1]) {
          const file = path.join(root, `${position}-${part}.webm`);
          await encodeWebm(
            { sampleRate: RATE, samples: tone((lengths[index] ?? 1) / 2, 300 * position) },
            file,
            encoder,
          );
          parts.push(file);
        }
        const audioPath = storage.audioRelPath("b", position);
        const { durationSeconds } = await concatWebm(parts, storage.resolve(audioPath), encoder);
        chapters.push({ position, title, audioPath, durationSeconds });
      }
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const build = async (coverFile: string | null, name: string, raw?: Buffer) => {
      let coverPath: string | null = null;
      if (coverFile && raw) {
        coverPath = path.join("books", "b", coverFile);
        fs.mkdirSync(storage.bookDir("b"), { recursive: true });
        fs.writeFileSync(storage.resolve(coverPath), raw);
      } else if (coverFile) {
        coverPath = path.join("books", "b", coverFile);
        fs.mkdirSync(storage.bookDir("b"), { recursive: true });
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=teal:s=120x180:d=1",
          "-frames:v",
          "1",
          "-y",
          storage.resolve(coverPath),
        ]);
      }
      const workDir = path.join(root, name);
      fs.mkdirSync(workDir);
      const producer = createOutputProducer({
        storage,
        ffmpegBin: "ffmpeg",
        ffprobeBin: "ffprobe",
        m4bBitrate: "64k",
      });
      return producer.produce({
        book: { id: "b", title: "Book; with = odd # title", author: "Анна Автор", coverPath },
        chapters,
        workDir,
        signal: new AbortController().signal,
        onProgress: () => {},
      });
    };

    it("makes an AAC mono M4B with the chapters, tags and cover, and chapter marks at the real starts", async () => {
      const { m4bPath } = await build("cover.png", "with-png");

      const info = probe(m4bPath, "-show_chapters", "-show_streams", "-show_format");
      const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
      const picture = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      expect(audio).toMatchObject({ codec_name: "aac", channels: 1 });
      expect(Math.abs(Number(audio.bit_rate) - 64_000)).toBeLessThan(4000);
      // A PNG cover is decoded and encoded again: what the M4B holds is a JPEG made here.
      expect(picture).toMatchObject({ codec_name: "mjpeg", disposition: { attached_pic: 1 } });
      expect(info.format.tags).toMatchObject({
        title: "Book; with = odd # title",
        artist: "Анна Автор",
        album: "Book; with = odd # title",
      });
      expect(info.format.format_name).toContain("mp4");
      expect(info.chapters.map((c: { tags: { title: string } }) => c.tags.title)).toEqual(titles);

      // Start times are the running total of the chapter files' real lengths.
      let elapsed = 0;
      for (const [index, chapter] of info.chapters.entries()) {
        expect(Math.abs(Number(chapter.start_time) - elapsed)).toBeLessThan(0.002);
        const file = storage.resolve(chapters[index]?.audioPath ?? "");
        elapsed += Number(probe(file, "-show_format").format.duration);
      }
      expect(Math.abs(Number(info.format.duration) - elapsed)).toBeLessThan(0.5);
    });

    const transportStream = () => {
      const out = path.join(root, "real.ts");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=d=1",
        "-c:a",
        "aac",
        "-f",
        "mpegts",
        "-y",
        out,
      ]);
      return fs.readFileSync(out);
    };

    /** A test that the book is still built, without a picture, from a cover file made of `bytes()`. */
    const crafted = (name: string, bytes: () => Buffer) =>
      it(`builds the audiobook without a picture from ${name}`, async () => {
        const { m4bPath } = await build("cover.bin", `evil-${name.replace(/\W+/g, "-")}`, bytes());

        expect(pictureOf(m4bPath)).toBeUndefined();
        expect(
          probe(m4bPath, "-show_streams").streams.some(
            (s: { codec_type: string }) => s.codec_type === "audio",
          ),
        ).toBe(true);
      });

    const makePicture = (file: string, size: string, extra: string[] = []) => {
      const out = path.join(root, file);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=teal:s=${size}:d=1`,
        "-frames:v",
        "1",
        ...extra,
        "-y",
        out,
      ]);
      return fs.readFileSync(out);
    };

    it.each([
      ["png", "cover.png"],
      ["jpeg", "cover.jpg"],
      ["gif", "cover.gif"],
      ["webp", "cover.webp"],
    ])(
      "makes a JPEG attached picture from a %s cover, and the M4B still plays",
      async (_format, file) => {
        const { m4bPath } = await build(
          file,
          `cover-${file}`,
          makePicture(`in-${file}`, "120x180"),
        );

        expect(pictureOf(m4bPath)).toMatchObject({
          codec_name: "mjpeg",
          width: 120,
          height: 180,
          disposition: { attached_pic: 1 },
        });
        expect(playsFully(m4bPath)).toBe(true);
      },
    );

    it("shrinks a large cover to 1400 px wide", async () => {
      const { m4bPath } = await build(
        "cover.png",
        "big-cover",
        makePicture("big.png", "3000x2000"),
      );

      expect(pictureOf(m4bPath)).toMatchObject({ codec_name: "mjpeg", width: 1400, height: 934 });
    });

    it("declares a cover by what it is, not by its name: a WebP file called .png is still a WebP", async () => {
      const { m4bPath } = await build("cover.png", "webp-as-png", makePicture("w.webp", "64x48"));

      expect(pictureOf(m4bPath)).toMatchObject({ codec_name: "mjpeg", width: 64 });
    });

    describe("files that only pretend to be covers", () => {
      crafted("a GIF header followed by MPEG-TS", () =>
        Buffer.concat([Buffer.from("GIF89a"), transportStream()]),
      );
      crafted("a bare transport stream", transportStream);
      crafted("a playlist that points at a file", () =>
        Buffer.from("#EXTM3U\n#EXTINF:1,x\nfile:///etc/hostname\n"),
      );
      crafted("a PNG header that claims 20000 x 20000", () => png(20_000, 20_000));
      crafted("a JPEG header that claims 65535 x 65535", () => jpeg(65_535, 65_535));
      crafted("an empty file", () => Buffer.alloc(0));
    });

    it("has no picture stream for a book without a cover", async () => {
      const { m4bPath } = await build(null, "no-cover");

      const info = probe(m4bPath, "-show_streams");
      expect(info.streams.some((s: { codec_type: string }) => s.codec_type === "video")).toBe(
        false,
      );
    });

    it("makes a ZIP of stored, numbered, tagged WebM files with the audio packets untouched", async () => {
      const { zipPath } = await build(null, "zip");

      const zip = await JSZip.loadAsync(fs.readFileSync(zipPath), { checkCRC32: true });
      expect(Object.keys(zip.files)).toEqual([
        "01 - Plain.webm",
        "02 - Odd = ; # chars and a second line.webm",
        "03 - Глава «Київ» частина 1.webm",
        "04 - etc passwd.webm",
      ]);
      for (const [index, name] of Object.keys(zip.files).entries()) {
        const extracted = path.join(root, `extracted-${index}.webm`);
        fs.writeFileSync(extracted, (await zip.file(name)?.async("nodebuffer")) ?? Buffer.alloc(0));
        const info = probe(extracted, "-show_format", "-show_streams");
        expect(info.streams).toHaveLength(1);
        expect(info.streams[0]).toMatchObject({ codec_name: "opus", channels: 1 });
        const tags = Object.fromEntries(
          Object.entries(info.format.tags as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        expect(tags).toMatchObject({
          title: titles[index],
          artist: "Анна Автор",
          album: "Book; with = odd # title",
          track: String(index + 1),
        });
        expect(packetsMd5(extracted)).toBe(
          packetsMd5(storage.resolve(chapters[index]?.audioPath ?? "")),
        );
      }
    });

    it("refuses a chapter file whose end is missing, even though its header still has the full length", async () => {
      const file = storage.resolve(chapters[1]?.audioPath ?? "");
      const whole = fs.readFileSync(file);
      fs.writeFileSync(file, whole.subarray(0, Math.floor(whole.length / 3)));
      try {
        await expect(build(null, "truncated")).rejects.toMatchObject({
          message: expect.stringContaining("chapter 2 is incomplete"),
        });
      } finally {
        fs.writeFileSync(file, whole);
      }
    });
  },
);
