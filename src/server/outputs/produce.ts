import fsp from "node:fs/promises";
import path from "node:path";
import { concatList } from "../audio/ffmpeg.js";
import type { Chapter } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import type { ProcessRunner } from "../process.js";
import { buildM4bArgs, buildTagArgs, ProgressReader } from "./commands.js";
import { NO_SPACE_MESSAGE, OutputError } from "./errors.js";
import { inspectChapters, prepareCover, type InspectedChapter } from "./inspect.js";
import { buildFfmetadata, chapterMarks, tagValue } from "./metadata.js";
import { chapterFileNames } from "./names.js";
import { Tools } from "./tools.js";
import { ZipWriter, type ZipOptions } from "./zip.js";

/** What a build is given. Everything it writes goes in `workDir`, which the caller removes. */
export interface OutputJob {
  book: { id: string; title: string; author: string | null; coverPath: string | null };
  chapters: readonly Pick<Chapter, "position" | "title" | "audioPath" | "durationSeconds">[];
  workDir: string;
  signal: AbortSignal;
  /** 0 to 1 */
  onProgress(fraction: number): void;
}

/** The finished files, inside `workDir`. */
export interface BuiltOutputs {
  m4bPath: string;
  zipPath: string;
}

export interface OutputProducer {
  produce(job: OutputJob): Promise<BuiltOutputs>;
}

export interface ProducerOptions {
  storage: Storage;
  ffmpegBin: string;
  ffprobeBin: string;
  /** AAC bitrate of the M4B, such as `64k`. */
  m4bBitrate: string;
  run?: ProcessRunner;
  niceBin?: string | null;
  /** A build stops before it starts when less than this plus what it needs is free. */
  minFreeBytes?: number;
  /** Free bytes on the disk that holds `dir`. Replaced in tests. */
  freeBytes?: (dir: string) => Promise<number>;
  zip?: ZipOptions;
  logger?: { warn(context: object, message: string): void };
}

// Progress: checking the files, then the M4B (almost all the time), then the ZIP.
const AFTER_INSPECT = 0.05;
const AFTER_M4B = 0.9;
// The M4B is about twice the size of the chapter files, and `+faststart` makes a second copy of it
// while it moves the index to the front; the ZIP is the size of the chapters. Files of an earlier
// build are on the disk already, so the free space measured now has them taken out.
const SPACE_FACTOR = 4.5;
const BASE_TIMEOUT_MS = 30 * 60_000;
const TIMEOUT_MS_PER_AUDIO_SECOND = 250;
// How far the encoded length may be from the sum of the chapter lengths before the markers cannot be trusted.
const MAX_LENGTH_DRIFT_SECONDS = 1;

async function freeBytesOf(dir: string): Promise<number> {
  const stats = await fsp.statfs(dir);
  return stats.bavail * stats.bsize;
}

/** Builds the M4B and the WebM ZIP of a finished book from its chapter files. */
export function createOutputProducer(options: ProducerOptions): OutputProducer {
  const { storage, m4bBitrate, zip, logger } = options;
  const tools = new Tools(options);
  const freeBytes = options.freeBytes ?? freeBytesOf;
  const minFreeBytes = options.minFreeBytes ?? 0;

  async function ensureRoom(chapters: readonly InspectedChapter[]): Promise<void> {
    const needed = chapters.reduce((sum, c) => sum + c.bytes, 0) * SPACE_FACTOR + minFreeBytes;
    let free: number;
    try {
      free = await freeBytes(storage.dataDir);
    } catch {
      return; // A file system that cannot say is not treated as full.
    }
    if (free < needed) {
      throw new OutputError(NO_SPACE_MESSAGE, {
        detail: `${Math.round(free / 1024 ** 2)} MB free, ${Math.round(needed / 1024 ** 2)} MB needed`,
      });
    }
  }

  async function buildM4b(job: OutputJob, chapters: readonly InspectedChapter[]): Promise<string> {
    const { book, workDir, signal } = job;
    const coverPath = await prepareCover(
      tools,
      storage,
      book.coverPath,
      workDir,
      signal,
      (context, message) => logger?.warn({ ...context, bookId: book.id }, message),
    );
    const marks = chapterMarks(
      chapters.map((c) => ({ title: c.title, durationSeconds: c.seconds })),
    );
    const listPath = path.join(workDir, "chapters.list");
    const metadataPath = path.join(workDir, "metadata.txt");
    const outputPath = path.join(workDir, "book.m4b");
    await fsp.writeFile(listPath, concatList(chapters.map((c) => c.file)));
    await fsp.writeFile(
      metadataPath,
      buildFfmetadata({
        title: book.title,
        artist: book.author,
        album: book.title,
        chapters: marks,
      }),
    );

    const total = chapters.reduce((sum, c) => sum + c.seconds, 0);
    const progress = new ProgressReader();
    await tools.ffmpeg(
      buildM4bArgs({ listPath, metadataPath, coverPath, bitrate: m4bBitrate, outputPath }),
      {
        signal,
        timeoutMs: BASE_TIMEOUT_MS + total * TIMEOUT_MS_PER_AUDIO_SECOND,
        lowPriority: true,
        onStdout: (chunk) => {
          const done = progress.feed(chunk);
          job.onProgress(AFTER_INSPECT + (AFTER_M4B - AFTER_INSPECT) * Math.min(1, done / total));
        },
      },
    );
    // The chapter markers are where the chapter files start if the audio is as long as the files say.
    if (Math.abs(progress.seconds - total) > MAX_LENGTH_DRIFT_SECONDS) {
      throw new OutputError("The audiobook came out with a different length than its chapters.", {
        detail: `encoded ${progress.seconds.toFixed(2)} s, chapters add up to ${total.toFixed(2)} s`,
      });
    }
    return outputPath;
  }

  async function buildZip(job: OutputJob, chapters: readonly InspectedChapter[]): Promise<string> {
    const { book, workDir, signal } = job;
    const zipPath = path.join(workDir, "book.zip");
    const names = chapterFileNames(chapters.map((c) => c.title));
    const tagged = path.join(workDir, "tagged.webm");
    const modified = new Date();
    const writer = await ZipWriter.create(zipPath, zip);
    try {
      for (const [index, chapter] of chapters.entries()) {
        await tools.ffmpeg(
          buildTagArgs({
            inputPath: chapter.file,
            outputPath: tagged,
            title:
              chapter.title.trim() === "" ? `Chapter ${chapter.position}` : tagValue(chapter.title),
            artist: book.author ? tagValue(book.author) : null,
            album: tagValue(book.title),
            track: chapter.position,
          }),
          { signal, timeoutMs: 5 * 60_000 },
        );
        await writer.addFile(names[index] as string, tagged, modified);
        await fsp.rm(tagged, { force: true });
        job.onProgress(AFTER_M4B + (1 - AFTER_M4B) * ((index + 1) / chapters.length));
      }
      await writer.finish();
    } catch (error) {
      await writer.close();
      throw error;
    }
    return zipPath;
  }

  return {
    async produce(job) {
      if (job.chapters.length === 0) throw new OutputError("This book has no chapters.");
      const chapters = await inspectChapters(
        tools,
        storage,
        job.chapters,
        job.signal,
        (done, total) => job.onProgress(AFTER_INSPECT * (done / total)),
      );
      await ensureRoom(chapters);
      job.onProgress(AFTER_INSPECT);
      const m4bPath = await buildM4b(job, chapters);
      const zipPath = await buildZip(job, chapters);
      job.onProgress(1);
      return { m4bPath, zipPath };
    },
  };
}
