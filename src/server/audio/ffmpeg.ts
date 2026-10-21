import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UserFacingError } from "../errors.js";
import { runProcess, type ProcessRunner } from "../process.js";
import type { PcmAudio } from "../tts/engine.js";

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

export function pcmDurationSeconds(pcm: PcmAudio): number {
  return pcm.samples.length / 2 / pcm.sampleRate / pcm.channels;
}

/**
 * Encodes PCM to WebM/Opus at `outputPath`. ffmpeg writes to a temporary file
 * that is renamed on success, so readers never see a half-written chapter.
 */
export async function encodeWebm(
  pcm: PcmAudio,
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

  try {
    let result;
    try {
      result = await run(options.ffmpegBin, args, {
        input: pcm.samples,
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
    await fs.rename(tempPath, outputPath);
    return { durationSeconds: pcmDurationSeconds(pcm) };
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

const tail = (stderr: string) => stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
