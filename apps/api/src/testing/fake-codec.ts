import fs from "node:fs";
import type { EncodedAudio, PcmInput } from "../audio/ffmpeg.js";

const SAMPLE_RATE = 22_050;

/** Stands in for the Opus encoder: the "encoded" chunk is the PCM itself. */
export async function fakeEncode(pcm: PcmInput, outputPath: string): Promise<EncodedAudio> {
  const parts: Buffer[] = [];
  if (Buffer.isBuffer(pcm.samples)) parts.push(pcm.samples);
  else for await (const part of pcm.samples) parts.push(part);
  const bytes = Buffer.concat(parts);
  fs.writeFileSync(outputPath, bytes);
  return { durationSeconds: bytes.length / 2 / pcm.sampleRate };
}

/** Stands in for the join: the chapter file is the chunk files one after the other. */
export async function fakeJoin(
  files: readonly string[],
  outputPath: string,
  _signal?: AbortSignal,
  _fallbackSeconds?: number | null,
): Promise<EncodedAudio> {
  const bytes = Buffer.concat(files.map((file) => fs.readFileSync(file)));
  fs.writeFileSync(outputPath, bytes);
  return { durationSeconds: bytes.length / 2 / SAMPLE_RATE };
}
