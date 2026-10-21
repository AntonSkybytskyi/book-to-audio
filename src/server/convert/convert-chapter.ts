import path from "node:path";
import type { EncodedAudio } from "../audio/ffmpeg.js";
import type { ClaimedChapter } from "../books/queue.js";
import type { Storage } from "../books/storage.js";
import { chunkText } from "../tts/chunk.js";
import { pickVoice, TtsError, type PcmAudio, type TtsEngine } from "../tts/engine.js";

export interface ChapterConverterDeps {
  engine: TtsEngine;
  storage: Storage;
  encode: (pcm: PcmAudio, outputPath: string, signal?: AbortSignal) => Promise<EncodedAudio>;
}

export interface ConvertedChapter {
  /** Relative to the data directory. */
  audioPath: string;
  durationSeconds: number;
}

export type ChapterConverter = (
  task: ClaimedChapter,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => Promise<ConvertedChapter>;

// Encoding is one step after the last chunk; progress only reaches 1 when the file exists.
const SYNTHESIS_SHARE = 0.97;

export function createChapterConverter({
  engine,
  storage,
  encode,
}: ChapterConverterDeps): ChapterConverter {
  return async (task, onProgress, signal) => {
    const voice = pickVoice(engine, task.language);
    if (!voice) {
      throw new TtsError("voice_not_found", `No ${task.language} voice is installed`);
    }

    const chunks = chunkText(task.text, engine.maxInputChars, task.language);
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const parts: Buffer[] = [];
    let sampleRate = 0;
    let doneChars = 0;

    for (const chunk of chunks) {
      if (signal.aborted) throw new TtsError("aborted", "Conversion was cancelled");
      const pcm = await engine.synthesize({ text: chunk, voiceId: voice.id, speed: 1, signal });
      if (sampleRate !== 0 && pcm.sampleRate !== sampleRate) {
        throw new TtsError("synthesis_failed", "The engine changed its sample rate mid-chapter");
      }
      sampleRate = pcm.sampleRate;
      parts.push(pcm.samples);
      doneChars += chunk.length;
      onProgress((doneChars / totalChars) * SYNTHESIS_SHARE);
    }

    const audioPath = storage.audioRelPath(task.bookId, task.position);
    storage.ensureAudioDir(task.bookId);
    const { durationSeconds } = await encode(
      { sampleRate, channels: 1, samples: Buffer.concat(parts) },
      path.resolve(storage.resolve(audioPath)),
      signal,
    );
    return { audioPath, durationSeconds };
  };
}
