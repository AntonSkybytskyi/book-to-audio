import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Chapter } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import {
  buildCoverConvertArgs,
  buildPacketsArgs,
  buildProbeArgs,
  packetLineEnd,
} from "./commands.js";
import { OutputError, ToolExit } from "./errors.js";
import { hasSaneSize, HEADER_BYTES, INPUT_FORMAT, readImageInfo } from "./image.js";
import type { Tools } from "./tools.js";

/** A chapter file that was checked, with its real length. */
export interface InspectedChapter {
  position: number;
  title: string;
  file: string;
  bytes: number;
  seconds: number;
}

type ChapterRow = Pick<Chapter, "position" | "title" | "audioPath" | "durationSeconds">;

const PARALLEL_PROBES = 4;
/** How far the last packet may end from the length in the file's header before the file counts as cut short. */
const TRUNCATION_SLACK_SECONDS = 0.25;
/** The packet listing starts this far before the end of the file. */
const TAIL_SECONDS = 5;
/** A cover file larger than this is not read. */
const MAX_COVER_BYTES = 32 * 1024 * 1024;

/** The recorded length may differ from the file's by the padding of the last Opus frame, not by seconds. */
export const durationMatches = (actual: number, recorded: number): boolean =>
  Math.abs(actual - recorded) <= 0.25 + recorded * 0.001;

/**
 * Checks every chapter file before anything is built from it. A worker whose attempt went stale
 * can, rarely, replace a chapter file without the book's audio generation moving, so what is on
 * disk has to be looked at: it must exist, be mono Opus, be as long as the database says, and
 * really contain audio to its end. The lengths come from ffprobe, not from the database, because
 * the chapter markers must match the audio that is in the file. `onChecked` is told how many
 * chapters are done. When one chapter fails the probes still running for the others are stopped.
 */
export async function inspectChapters(
  tools: Tools,
  storage: Storage,
  chapters: readonly ChapterRow[],
  signal: AbortSignal,
  onChecked: (done: number, total: number) => void = () => {},
): Promise<InspectedChapter[]> {
  const stop = new AbortController();
  const relay = () => stop.abort();
  signal.addEventListener("abort", relay, { once: true });
  if (signal.aborted) stop.abort();
  const inspected: InspectedChapter[] = [];
  let checked = 0;
  try {
    for (let from = 0; from < chapters.length; from += PARALLEL_PROBES) {
      const batch = chapters.slice(from, from + PARALLEL_PROBES);
      inspected.push(
        ...(await Promise.all(
          batch.map(async (chapter) => {
            try {
              const inspectedChapter = await inspectChapter(tools, storage, chapter, stop.signal);
              onChecked(++checked, chapters.length);
              return inspectedChapter;
            } catch (error) {
              stop.abort();
              throw error;
            }
          }),
        )),
      );
    }
    return inspected;
  } finally {
    signal.removeEventListener("abort", relay);
  }
}

async function inspectChapter(
  tools: Tools,
  storage: Storage,
  chapter: ChapterRow,
  signal: AbortSignal,
): Promise<InspectedChapter> {
  const { position, title } = chapter;
  const regenerate = `Regenerate chapter ${position}, then the downloads are built again.`;
  if (!chapter.audioPath || !chapter.durationSeconds) {
    throw new OutputError(`Chapter ${position} has no audio. ${regenerate}`);
  }
  const file = storage.resolve(chapter.audioPath);
  let bytes: number;
  try {
    bytes = (await fsp.stat(file)).size;
  } catch {
    throw new OutputError(`The audio file of chapter ${position} is missing. ${regenerate}`);
  }

  let probe: {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; channels?: number }[];
  };
  try {
    probe = JSON.parse(await tools.ffprobe(buildProbeArgs(file), signal));
  } catch (error) {
    // ffprobe is missing, or the build was cancelled: not this file's fault.
    if (!(error instanceof ToolExit || error instanceof SyntaxError)) throw error;
    throw new OutputError(`The audio file of chapter ${position} cannot be read. ${regenerate}`, {
      cause: error,
    });
  }
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const seconds = Number(probe.format?.duration);
  if (audio?.codec_name !== "opus" || audio.channels !== 1 || !(seconds > 0)) {
    throw new OutputError(`The audio file of chapter ${position} is not valid. ${regenerate}`);
  }
  if (!durationMatches(seconds, chapter.durationSeconds)) {
    throw new OutputError(
      `The audio file of chapter ${position} is not the one that was recorded (${seconds.toFixed(1)} s, expected ${chapter.durationSeconds.toFixed(1)} s). ${regenerate}`,
    );
  }
  // The header keeps the length of the whole file even if the end of it is gone: look at the audio itself.
  let end: number | null;
  try {
    const line = await tools.ffprobeLastLine(
      buildPacketsArgs(file, seconds - TAIL_SECONDS),
      signal,
    );
    end = line === null ? null : packetLineEnd(line);
  } catch (error) {
    if (!(error instanceof ToolExit)) throw error;
    end = null;
  }
  if (end === null || end < seconds - TRUNCATION_SLACK_SECONDS) {
    throw new OutputError(`The audio file of chapter ${position} is incomplete. ${regenerate}`, {
      detail: `last packet ends at ${end ?? "n/a"} s, the header says ${seconds} s`,
    });
  }
  return { position, title, file, bytes, seconds };
}

/**
 * The cover as a JPEG that an MP4 can hold, in `workDir`, or null for no cover. The file is
 * untrusted, and ffmpeg decides what a file is from its content, so this does not let it: the
 * header is read here first (PNG, JPEG, GIF87a/89a and WebP only, at most 50 megapixels, at most
 * 32 MB), and ffmpeg is then told to read it as exactly that format, with only the `file`
 * protocol and a pixel cap of its own. The picture is always decoded and encoded again, never
 * copied, so what goes into the M4B is a JPEG made here. A cover that fails any of this is left
 * out with a warning, and the book is still built.
 */
export async function prepareCover(
  tools: Tools,
  storage: Storage,
  coverPath: string | null,
  workDir: string,
  signal: AbortSignal,
  warn: (context: object, message: string) => void,
): Promise<string | null> {
  if (!coverPath) return null;
  const file = storage.resolve(coverPath);
  try {
    const info = await readCoverHeader(file);
    if (info === null) {
      warn({}, "the cover is not a PNG, JPEG, GIF or WebP picture, building without it");
      return null;
    }
    if (!hasSaneSize(info)) {
      warn(
        { width: info.width, height: info.height },
        "the cover is too large or empty, building without it",
      );
      return null;
    }
    const converted = path.join(workDir, `cover-${randomUUID()}.jpg`);
    await tools.ffmpeg(buildCoverConvertArgs(INPUT_FORMAT[info.format], file, converted), {
      signal,
      timeoutMs: 60_000,
      lowPriority: true,
    });
    return converted;
  } catch (error) {
    if (signal.aborted) throw error;
    warn({ err: error }, "the cover could not be used, building without it");
    return null;
  }
}

/** The format and size of the cover from the start of the file, or null when it is too big to trust or not a picture. */
async function readCoverHeader(file: string) {
  const handle = await fsp.open(file, "r");
  try {
    if ((await handle.stat()).size > MAX_COVER_BYTES) return null;
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return readImageInfo(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
