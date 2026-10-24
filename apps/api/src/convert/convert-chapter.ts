import fs from "node:fs";
import path from "node:path";
import type { EncodedAudio, PcmInput } from "../audio/ffmpeg.js";
import type { ClaimedChapter } from "../books/queue.js";
import type { Storage } from "../books/storage.js";
import { UserFacingError } from "../errors.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { TtsError, type PcmAudio } from "../tts/engine.js";
import { prepareInThread, type TextPreparer } from "./chapter-text.js";
import type { ChunkStore } from "./chunk-store.js";
import { DEFAULT_RETRY_DELAYS_MS, sleep, type Sleep } from "./retry.js";
import type { SessionHolder } from "./sessions.js";

export interface ConverterLogger {
  warn(context: object, message: string): void;
}

export interface ChapterConverterDeps {
  catalog: TtsCatalog;
  storage: Storage;
  chunks: ChunkStore;
  /** Encodes one chunk to a WebM/Opus file at `outputPath`. */
  encode: (pcm: PcmInput, outputPath: string, signal?: AbortSignal) => Promise<EncodedAudio>;
  /** Joins chunk files into the chapter file at `outputPath` without re-encoding. */
  join: (
    files: readonly string[],
    outputPath: string,
    signal?: AbortSignal,
    /** Summed chunk lengths, for when the joiner cannot measure the result itself. */
    fallbackSeconds?: number | null,
  ) => Promise<EncodedAudio>;
  logger?: ConverterLogger;
  /** Prepares and splits a chapter's text; production passes one that runs in a worker thread. */
  prepareText?: TextPreparer;
  /** Waits before each retry of a chunk; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
  sleep?: Sleep;
}

export interface ConvertedChapter {
  /** Relative to the data directory. */
  audioPath: string;
  durationSeconds: number;
  /** What the speed estimates learn from. Set by the real converter. */
  voiceId?: string;
  /** Characters of prepared text the chapter was read from. */
  preparedChars?: number;
  /** Chunk attempts that failed and were tried again; such a chapter's time says little about speed. */
  retries?: number;
}

export interface ChapterRun {
  task: ClaimedChapter;
  /** The worker's engine session, reused across chunks and chapters; it is on the worker's TTS service. */
  sessions: SessionHolder;
  signal: AbortSignal;
  /**
   * Records `done` of `total` chunks finished. Returns false when the claim is
   * stale, and the converter then stops.
   */
  saveProgress(done: number, total: number): boolean;
}

export interface ChapterConverter {
  /**
   * Synthesizes and encodes the chunks that are not on disk yet, then joins them all.
   * Throws `TtsError` with code `aborted` when cancelled or replaced.
   */
  convert(run: ChapterRun): Promise<ConvertedChapter>;
  /** Removes the chunks once the chapter is finished or failed. */
  discardChunks(task: ClaimedChapter): void;
  /** Removes an encoded file whose result was not recorded. */
  discardAudio(audioPath: string): void;
}

/** What is left of a chunk with nothing to read aloud, such as "* * *": a short pause. */
const SILENCE_SECONDS = 0.3;
const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

const cancelled = () => new TtsError("aborted", "Conversion was cancelled");

/**
 * Retrying cannot help when the engine or voice is missing, or the text itself is the problem. A
 * service that does not answer was already tried again by the client.
 */
const NOT_RETRYABLE = new Set([
  "engine_unavailable",
  "voice_not_found",
  "bad_input",
  "aborted",
  "unreachable",
]);

export function createChapterConverter({
  catalog,
  storage,
  chunks: store,
  encode,
  join,
  logger,
  prepareText = prepareInThread,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep: wait = sleep,
}: ChapterConverterDeps): ChapterConverter {
  /** One chunk, with up to `retryDelaysMs.length` retries on a fresh engine session. */
  async function synthesize(
    run: ChapterRun,
    voiceId: string,
    text: string,
    index: number,
    total: number,
    counts: { retries: number },
  ): Promise<PcmAudio> {
    const { task, sessions, signal } = run;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw cancelled();
      try {
        return await sessions.synthesize(voiceId, text, signal);
      } catch (error) {
        const code = error instanceof TtsError ? error.code : null;
        if (signal.aborted || code === "aborted") throw cancelled();
        const delay = retryDelaysMs[attempt - 1];
        const retryable = !(code && NOT_RETRYABLE.has(code));
        const where = { bookId: task.bookId, chapter: task.position, chunk: index + 1, of: total };
        if (delay === undefined || !retryable) {
          logger?.warn({ err: error, detail: detailOf(error), ...where, attempt }, "chunk failed");
          if (error instanceof TtsError && retryable) {
            throw new TtsError(
              code ?? "synthesis_failed",
              `${error.message} Tried ${attempt} times.`,
              {
                cause: error,
                detail: error.detail,
              },
            );
          }
          throw error;
        }
        logger?.warn(
          { err: error, detail: detailOf(error), ...where, attempt },
          `chunk failed, retrying in ${delay / 1000} s`,
        );
        counts.retries++;
        await wait(delay, signal);
      }
    }
  }

  return {
    async convert(run) {
      const { task, signal } = run;
      const voice = catalog.voiceFor(task.language);
      // The language's voice moved to another service, or went away, after the claim: the chapter
      // goes back to the queue for the workers of the service that reads it now.
      if (!voice || voice.engine !== run.sessions.engineId) throw cancelled();

      const maxChars = catalog.maxCharsFor(task.language);
      const texts = await prepareText(task.text, task.language, maxChars, signal);
      if (signal.aborted) throw cancelled();
      if (texts.length === 0) {
        throw new TtsError("bad_input", "This chapter has no text to read aloud.");
      }
      const total = texts.length;
      const counts = { retries: 0 };

      // Chunks are only reused if they were made by this service, voice and speaker, from text
      // prepared by the same rules, for the same split.
      const first = store.open(task.bookId, task.position, {
        engine: voice.engine,
        voice: voice.id,
        speaker: voice.speaker ?? null,
        sampleRate: voice.sampleRate,
        chunkCount: total,
        textVersion: TEXT_PROCESSING_VERSION,
      });
      if (!run.saveProgress(first, total)) throw cancelled();

      for (let index = first; index < total; index++) {
        if (signal.aborted) throw cancelled();
        await store.ensureSpace();
        const text = texts[index] ?? "";
        let samples: Buffer;
        if (hasWords(text)) {
          const pcm = await synthesize(run, voice.id, text, index, total, counts);
          if (pcm.sampleRate !== voice.sampleRate) {
            throw new TtsError(
              "synthesis_failed",
              "The engine changed its sample rate mid-chapter",
            );
          }
          samples = pcm.samples;
        } else {
          samples = Buffer.alloc(Math.round(voice.sampleRate * SILENCE_SECONDS) * 2);
        }
        const chunkPath = store.chunkPath(task.bookId, task.position, index);
        const encoded = await encode({ sampleRate: voice.sampleRate, samples }, chunkPath, signal);
        store.saveDuration(task.bookId, task.position, index, encoded.durationSeconds);
        if (!run.saveProgress(index + 1, total)) throw cancelled();
      }
      if (signal.aborted) throw cancelled();

      // `audio/<book>` is made when the book is queued; it is not made again here, so a
      // book that was deleted meanwhile makes this fail instead of leaving files behind.
      const audioPath = storage.audioRelPath(task.bookId, task.position);
      const { durationSeconds } = await join(
        store.chunkPaths(task.bookId, task.position, total),
        path.resolve(storage.resolve(audioPath)),
        signal,
        store.totalSeconds(task.bookId, task.position, total),
      );
      return {
        audioPath,
        durationSeconds,
        voiceId: voice.id,
        preparedChars: texts.reduce((sum, text) => sum + text.length, 0),
        retries: counts.retries,
      };
    },

    discardChunks: (task) => store.remove(task.bookId, task.position),

    discardAudio: (audioPath) => fs.rmSync(storage.resolve(audioPath), { force: true }),
  };
}

const detailOf = (error: unknown) => (error instanceof UserFacingError ? error.detail : undefined);
