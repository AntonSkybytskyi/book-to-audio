import {
  audioSecondsFor,
  conversionSeconds,
  suggestedWorkers,
  type BenchmarkRowView,
  type BenchmarkServiceView,
  type BenchmarkView,
  type ResultView,
} from "@book-to-audio/contracts";
import { LANGUAGES } from "../books/languages.js";
import { benchmarkModel } from "../speed/calibration.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { benchmarkVoices } from "./runner.js";
import {
  wasBusy,
  type BenchmarkRepository,
  type MachineInfo,
  type StoredBenchmark,
} from "./repository.js";
import type { BenchmarkStatus } from "./status.js";
export type { BenchmarkView } from "@book-to-audio/contracts";

/** The yardstick of the Speed table: a novel of 90,000 words (about 10 hours of audio) in 30 chapters. */
const NOVEL_WORDS = 90_000;
const NOVEL_CHAPTERS = 30;
/** Characters of prepared text per word, spaces and punctuation included. */
const CHARS_PER_WORD: Readonly<Record<string, number>> = { en: 5.8, uk: 7.3, ru: 7.1 };

export interface BenchmarkViewDeps {
  catalog: TtsCatalog;
  repo: BenchmarkRepository;
  status: BenchmarkStatus;
  machine: MachineInfo;
  /** A TTS service's worker count in use, and the most sessions worth comparing on it. */
  workers: (service: string) => { current: number; max: number };
  needsRun: boolean;
}

function toResultView(result: StoredBenchmark, machine: MachineInfo, workers: number): ResultView {
  const model = benchmarkModel(result);
  const chars = NOVEL_WORDS * (CHARS_PER_WORD[result.language] ?? 6.5);
  const novelAudioSeconds = audioSecondsFor(model, chars);
  const chapters = Array.from({ length: NOVEL_CHAPTERS }, () => novelAudioSeconds / NOVEL_CHAPTERS);
  return {
    secondsPerKChar: result.secondsPerKChar,
    rtf: result.rtf,
    encodeFactor: result.encodeFactor,
    modelLoadSeconds: result.modelLoadMs / 1000,
    throughput: result.throughput,
    sampleChars: result.sampleChars,
    sampleAudioSeconds: result.sampleAudioSeconds,
    measuredAt: result.measuredAt,
    novelAudioSeconds,
    novelConvertSeconds: conversionSeconds(model, chapters, workers),
    loadStart: result.loadStart,
    loadEnd: result.loadEnd,
    busy: wasBusy(result),
    outdated:
      result.cpuCount !== machine.cpuCount ||
      result.cpuModel !== machine.cpuModel ||
      result.textVersion !== TEXT_PROCESSING_VERSION,
  };
}

/** The Speed section of the settings page: one row per voice the app reads with. */
export function toBenchmarkView(deps: BenchmarkViewDeps): BenchmarkView {
  const { catalog, repo, machine, workers } = deps;
  const rows = benchmarkVoices(catalog).map((voice): BenchmarkRowView => {
    const row = repo.get(voice.engine, voice.id);
    return {
      language: voice.language,
      voiceId: voice.id,
      service: voice.engine,
      result: row ? toResultView(row, machine, workers(voice.engine).current) : null,
    };
  });
  const services = [...new Set(rows.map((row) => row.service))].map((id): BenchmarkServiceView => {
    const own = rows.filter((row) => row.service === id);
    // Added up over the service's voices so one odd measurement does not decide.
    const counts = new Set(
      own.flatMap((row) => row.result?.throughput.map((p) => p.workers) ?? []),
    );
    const combined = [...counts]
      .toSorted((a, b) => a - b)
      .map((n) => ({
        workers: n,
        audioPerSecond: own.reduce(
          (sum, row) =>
            sum + (row.result?.throughput.find((p) => p.workers === n)?.audioPerSecond ?? 0),
          0,
        ),
      }));
    const { current, max } = workers(id);
    return {
      id,
      workers: current,
      maxWorkers: max,
      suggestedWorkers: combined.length > 0 ? suggestedWorkers(combined) : null,
    };
  });
  return {
    ...deps.status,
    rows: LANGUAGES.flatMap((language) => rows.filter((row) => row.language === language)),
    services,
    machine,
    needsRun: deps.needsRun,
  };
}
