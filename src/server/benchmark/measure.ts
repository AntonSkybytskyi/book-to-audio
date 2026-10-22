import fs from "node:fs/promises";
import path from "node:path";
import type { ThroughputPoint } from "../../shared/estimate.js";
import type { EncodedAudio, PcmInput } from "../audio/ffmpeg.js";
import { isLanguage } from "../books/languages.js";
import {
  TtsError,
  type PcmAudio,
  type TtsEngine,
  type TtsSession,
  type Voice,
} from "../tts/engine.js";
import type { VoiceMeasurement } from "./repository.js";
import { BENCHMARK_SAMPLES, WARM_UP } from "./samples.js";

export interface MeasureDeps {
  engine: TtsEngine;
  /** The chunks a chapter of this text would be read in: same rules, same splitting. */
  prepare: (text: string, language: string, maxChars: number) => string[];
  /** Encodes a chunk the way a chapter does; without it the encoding cost is not measured. */
  encode?: (pcm: PcmInput, outputPath: string, signal?: AbortSignal) => Promise<EncodedAudio>;
  /** Folder for the encoded chunks, which are removed straight away. */
  scratchDir: string;
  /** Milliseconds from a clock that never goes back. */
  now: () => number;
}

export interface MeasureOptions {
  /** Session counts to measure, each read at the same time. One is always measured first. */
  workerCounts: readonly number[];
  /**
   * Times the sample is read in each step. The engine is quick, so one pass is a few seconds and a
   * busy moment on the machine would show; reading it several times averages that out.
   */
  repeat?: number;
  signal?: AbortSignal;
  /** Called after each step with the share of this voice that is done. */
  onProgress?: (share: number) => void;
}

interface Read {
  synthMs: number;
  encodeMs: number;
  audioSeconds: number;
}

const BYTES_PER_SAMPLE = 2;
const DEFAULT_REPEAT = 2;
const secondsOf = (pcm: PcmAudio) => pcm.samples.length / BYTES_PER_SAMPLE / pcm.sampleRate;

/**
 * Waits for every promise, also after one has failed (which aborts `step` so the rest stop early), and
 * then rejects with the first failure. A session that is still being opened when another fails is
 * therefore known to the caller before it cleans up, and never left running.
 */
async function allOrFirstError<T>(promises: Promise<T>[], step: AbortController): Promise<T[]> {
  let failure: { error: unknown } | null = null;
  const watched = promises.map((promise) =>
    promise.catch((error: unknown) => {
      failure ??= { error };
      step.abort();
    }),
  );
  await Promise.all(watched);
  if (failure) throw (failure as { error: unknown }).error;
  return Promise.all(promises);
}

/**
 * Measures one voice through the engine's own sessions, as a conversion uses them: the speech
 * rate (audio per 1,000 characters of prepared text), the real-time factor of one session after a
 * warm-up chunk, the cost of the Opus encoding and the throughput with several sessions at once.
 * Every session it opens is closed, also when it fails or is cancelled.
 */
export async function measureVoice(
  deps: MeasureDeps,
  voice: Voice,
  options: MeasureOptions,
): Promise<VoiceMeasurement> {
  const { engine, now } = deps;
  if (!isLanguage(voice.language)) {
    throw new TtsError("bad_input", `There is no benchmark text for "${voice.language}".`);
  }
  const language = voice.language;
  const chunks = deps.prepare(BENCHMARK_SAMPLES[language], language, engine.maxInputChars);
  const sampleChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const counts = [...new Set([1, ...options.workerCounts])].toSorted((a, b) => a - b);
  const repeat = Math.max(1, options.repeat ?? DEFAULT_REPEAT);

  let scratchCount = 0;
  const readAll = async (session: TtsSession, signal?: AbortSignal): Promise<Read> => {
    const read: Read = { synthMs: 0, encodeMs: 0, audioSeconds: 0 };
    for (const text of Array.from({ length: repeat }, () => chunks).flat()) {
      const started = now();
      const pcm = await session.synthesize(text, signal);
      read.synthMs += now() - started;
      read.audioSeconds += secondsOf(pcm);
      if (deps.encode) {
        const file = path.join(deps.scratchDir, `chunk-${++scratchCount}.webm`);
        const encodeStarted = now();
        try {
          await deps.encode({ sampleRate: pcm.sampleRate, samples: pcm.samples }, file, signal);
        } finally {
          read.encodeMs += now() - encodeStarted;
          await fs.rm(file, { force: true });
        }
      }
    }
    return read;
  };

  /** Opens sessions and reads a short line with each, so the model is loaded before anything is timed. */
  const open = (
    count: number,
    sessions: TtsSession[],
    step: AbortController,
    signal: AbortSignal,
  ) =>
    allOrFirstError(
      Array.from({ length: count }, async () => {
        const started = now();
        const session = await engine.open(voice.id);
        // Recorded the moment it exists, so the `finally` below closes it whenever it arrives.
        sessions.push(session);
        await session.synthesize(WARM_UP[language], signal);
        return now() - started;
      }),
      step,
    );

  const throughput: ThroughputPoint[] = [];
  let single: Read | null = null;
  let modelLoadMs = 0;

  for (const [index, count] of counts.entries()) {
    if (options.signal?.aborted) throw new TtsError("aborted", "The speed test was cancelled.");
    const sessions: TtsSession[] = [];
    // One failing session stops the others, and nothing is closed until every one has settled.
    const step = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, step.signal]) : step.signal;
    try {
      const loads = await open(count, sessions, step, signal);
      if (count === 1) modelLoadMs = loads[0] ?? 0;
      const started = now();
      const reads = await allOrFirstError(
        sessions.map((session) => readAll(session, signal)),
        step,
      );
      const wallSeconds = Math.max(now() - started, 1) / 1000;
      const audio = reads.reduce((sum, read) => sum + read.audioSeconds, 0);
      if (!(audio > 0)) throw new TtsError("bad_input", "The voice produced no audio.");
      throughput.push({ workers: count, audioPerSecond: audio / wallSeconds });
      if (count === 1) single = reads[0] ?? null;
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    options.onProgress?.((index + 1) / counts.length);
  }

  if (!single)
    throw new TtsError("synthesis_failed", "The benchmark did not run a single session.");
  return {
    engine: engine.id,
    voiceId: voice.id,
    language,
    secondsPerKChar: single.audioSeconds / repeat / (sampleChars / 1000),
    rtf: single.synthMs / 1000 / single.audioSeconds,
    encodeFactor: deps.encode ? single.encodeMs / 1000 / single.audioSeconds : null,
    modelLoadMs: Math.round(modelLoadMs),
    throughput,
    sampleChars,
    sampleAudioSeconds: single.audioSeconds / repeat,
  };
}
