import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UserFacingError } from "../errors.js";
import { runProcess, type ProcessRunner } from "../process.js";

export interface EncoderOptions {
  ffmpegBin: string;
  /** Opus bitrate such as `32k`. */
  bitrate: string;
  run?: ProcessRunner;
  timeoutMs?: number;
}

export interface EncodedAudio {
  durationSeconds: number;
}

export class EncodeError extends UserFacingError {
  constructor(message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.name = "EncodeError";
  }
}

// Opus accepts 8, 12, 16, 24 and 48 kHz. 24 kHz is plenty for speech.
const OUTPUT_SAMPLE_RATE = 24_000;
// Piper normalises its output to full scale, and Opus can overshoot the input peaks
// on decode, which clipped. 2 dB of headroom keeps decoded peaks below about -1 dB.
const HEADROOM_FILTER = "volume=-2dB";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** ffmpeg arguments that read raw PCM on stdin and write mono Opus in WebM. */
export function buildEncodeArgs(input: {
  sampleRate: number;
  bitrate: string;
  outputPath: string;
}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(input.sampleRate),
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-af",
    HEADROOM_FILTER,
    "-c:a",
    "libopus",
    "-b:a",
    input.bitrate,
    "-application",
    "voip",
    "-ar",
    String(OUTPUT_SAMPLE_RATE),
    "-ac",
    "1",
    "-f",
    "webm",
    "-y",
    input.outputPath,
  ];
}

/** Mono 16-bit PCM. An iterable is streamed into ffmpeg and never held whole. */
export interface PcmInput {
  sampleRate: number;
  samples: Buffer | AsyncIterable<Buffer>;
}

const BYTES_PER_SAMPLE = 2;

/**
 * Encodes PCM to WebM/Opus at `outputPath`. ffmpeg writes to a temporary file
 * that is renamed on success, so readers never see a half-written chapter.
 */
export async function encodeWebm(
  pcm: PcmInput,
  outputPath: string,
  options: EncoderOptions,
  signal?: AbortSignal,
): Promise<EncodedAudio> {
  const run = options.run ?? runProcess;
  const tempPath = path.join(path.dirname(outputPath), `.${randomUUID()}.tmp`);
  const args = buildEncodeArgs({
    sampleRate: pcm.sampleRate,
    bitrate: options.bitrate,
    outputPath: tempPath,
  });

  // The length is only known once everything has gone through.
  let bytes = 0;
  async function* counted(chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      yield chunk;
    }
  }
  const input = Buffer.isBuffer(pcm.samples) ? pcm.samples : counted(pcm.samples);

  try {
    let result;
    try {
      result = await run(options.ffmpegBin, args, {
        input,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new EncodeError(
        missing
          ? "ffmpeg is not installed, so audio cannot be encoded."
          : "The audio encoder could not be started.",
        { cause: error, detail: (error as Error).message },
      );
    }
    if (result.aborted) throw new EncodeError("Encoding was cancelled");
    if (result.timedOut) throw new EncodeError("Encoding the audio took too long.");
    if (result.code !== 0) {
      throw new EncodeError("The audio could not be encoded.", {
        detail: `ffmpeg exited with code ${result.code}: ${tail(result.stderr)}`,
      });
    }
    await syncFile(tempPath);
    await fs.rename(tempPath, outputPath);
    if (Buffer.isBuffer(pcm.samples)) bytes = pcm.samples.length;
    return { durationSeconds: bytes / BYTES_PER_SAMPLE / pcm.sampleRate };
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

/** Flushes a finished file to disk, so a rename that follows cannot leave an empty file after a crash. */
async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const tail = (stderr: string) => stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/** Arguments that join WebM/Opus files listed in `listPath` without re-encoding. */
export function buildConcatArgs(input: { listPath: string; outputPath: string }) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    input.listPath,
    "-c",
    "copy",
    "-f",
    "webm",
    "-y",
    input.outputPath,
  ];
}

/** One `file '<path>'` line per input (as an absolute path, which the demuxer needs), with quotes escaped the way the concat demuxer wants. */
export const concatList = (files: readonly string[]) =>
  files.map((file) => `file '${path.resolve(file).replaceAll("'", "'\\''")}'\n`).join("");

/**
 * Joins chunk files (each its own Opus stream, made by `encodeWebm`) into one chapter file
 * by copying the packets, so nothing is decoded or encoded twice. The chunks end in
 * silence, so the joins are not audible. The length comes from ffmpeg's own progress report.
 */
export async function concatWebm(
  files: readonly string[],
  outputPath: string,
  options: EncoderOptions,
  signal?: AbortSignal,
  /** Length to report if ffmpeg does not say: the sum of the chunk lengths, when they are known. */
  fallbackSeconds?: number | null,
): Promise<EncodedAudio> {
  const run = options.run ?? runProcess;
  const base = path.join(path.dirname(outputPath), `.${randomUUID()}`);
  const listPath = `${base}.list`;
  const tempPath = `${base}.tmp`;
  try {
    await fs.writeFile(listPath, concatList(files), { mode: 0o600, flag: "wx" });
    let result;
    try {
      result = await run(options.ffmpegBin, buildConcatArgs({ listPath, outputPath: tempPath }), {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new EncodeError(
        missing
          ? "ffmpeg is not installed, so audio cannot be encoded."
          : "The audio encoder could not be started.",
        { cause: error, detail: (error as Error).message },
      );
    }
    if (result.aborted) throw new EncodeError("Encoding was cancelled");
    if (result.timedOut) throw new EncodeError("Joining the audio took too long.");
    if (result.code !== 0) {
      throw new EncodeError("The audio could not be encoded.", {
        detail: `ffmpeg exited with code ${result.code}: ${tail(result.stderr)}`,
      });
    }
    const seconds = lastProgressSeconds(result.stdout.toString("utf8")) ?? fallbackSeconds ?? null;
    // A chapter file of unknown length would be stored as 0 s; better to fail than to lie.
    if (seconds === null || !(seconds > 0)) {
      throw new EncodeError("The length of the audio could not be worked out.", {
        detail: "ffmpeg reported no usable out_time_us and the chunk lengths are not known",
      });
    }
    await syncFile(tempPath);
    // The chapter file is replaced here, before the caller can record it. A caller whose claim
    // went stale meanwhile has still replaced the file, and nothing bumps its audio version.
    await fs.rename(tempPath, outputPath);
    return { durationSeconds: seconds };
  } finally {
    await Promise.all([fs.rm(listPath, { force: true }), fs.rm(tempPath, { force: true })]);
  }
}

/** The last usable `out_time_us=` line of ffmpeg's `-progress` output in seconds, or null (it prints `N/A` when unknown). */
export function lastProgressSeconds(progress: string): number | null {
  const matches = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
  const last = matches.at(-1)?.[1];
  const seconds = last === undefined ? 0 : Number(last) / 1_000_000;
  return seconds > 0 ? seconds : null;
}
