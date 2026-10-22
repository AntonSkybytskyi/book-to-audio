import type Database from "better-sqlite3";
import type { ThroughputPoint } from "../../shared/estimate.js";

export interface MachineInfo {
  cpuCount: number;
  cpuModel: string;
}

/** What one benchmark measured for one voice. */
export interface VoiceMeasurement {
  engine: string;
  voiceId: string;
  language: string;
  /** Seconds of audio per 1,000 characters of prepared text. */
  secondsPerKChar: number;
  /** Seconds of synthesis per second of audio, one session, model load excluded. */
  rtf: number;
  /** Seconds of Opus encoding per second of audio, or null when nothing was encoded. */
  encodeFactor: number | null;
  modelLoadMs: number;
  throughput: ThroughputPoint[];
  sampleChars: number;
  sampleAudioSeconds: number;
}

/** What was going on around a run. */
export interface RunInfo {
  /** The 1-minute load average when the run began (other programs) and when it ended (the run's own too). */
  loadStart: number | null;
  loadEnd: number | null;
  seconds: number | null;
}

export interface StoredBenchmark extends VoiceMeasurement, MachineInfo, RunInfo {
  textVersion: number;
  measuredAt: string;
  /** Runs in a row that began while the computer was busy. */
  loadAttempt: number;
}

/** The computer was busier than it has cores when the run began, so the numbers are probably too slow. */
export const wasBusy = (row: Pick<StoredBenchmark, "loadStart" | "cpuCount">): boolean =>
  (row.loadStart ?? 0) > row.cpuCount;

export const NO_RUN_INFO: RunInfo = { loadStart: null, loadEnd: null, seconds: null };

interface Row {
  engine: string;
  voice_id: string;
  language: string;
  seconds_per_kchar: number;
  rtf: number;
  encode_factor: number | null;
  model_load_ms: number;
  throughput: string;
  sample_chars: number;
  sample_audio_seconds: number;
  cpu_count: number;
  cpu_model: string;
  text_version: number;
  measured_at: string;
  load_start: number | null;
  load_end: number | null;
  load_attempt: number;
  run_seconds: number | null;
}

const toStored = (row: Row): StoredBenchmark => ({
  engine: row.engine,
  voiceId: row.voice_id,
  language: row.language,
  secondsPerKChar: row.seconds_per_kchar,
  rtf: row.rtf,
  encodeFactor: row.encode_factor,
  modelLoadMs: row.model_load_ms,
  throughput: JSON.parse(row.throughput) as ThroughputPoint[],
  sampleChars: row.sample_chars,
  sampleAudioSeconds: row.sample_audio_seconds,
  cpuCount: row.cpu_count,
  cpuModel: row.cpu_model,
  textVersion: row.text_version,
  measuredAt: row.measured_at,
  loadStart: row.load_start,
  loadEnd: row.load_end,
  loadAttempt: row.load_attempt,
  seconds: row.run_seconds,
});

/** The latest benchmark of each voice (migration 8). */
export class BenchmarkRepository {
  constructor(private readonly db: Database.Database) {}

  all(engine: string): StoredBenchmark[] {
    const rows = this.db
      .prepare("SELECT * FROM benchmark_results WHERE engine = ? ORDER BY language, voice_id")
      .all(engine) as Row[];
    return rows.map(toStored);
  }

  get(engine: string, voiceId: string): StoredBenchmark | undefined {
    const row = this.db
      .prepare("SELECT * FROM benchmark_results WHERE engine = ? AND voice_id = ?")
      .get(engine, voiceId) as Row | undefined;
    return row && toStored(row);
  }

  /**
   * Replaces the results of these voices in one step, and forgets what real conversions taught
   * about them: the new measurement is the baseline they are compared with from now on.
   */
  save(
    measurements: readonly VoiceMeasurement[],
    machine: MachineInfo,
    textVersion: number,
    measuredAt: string,
    run: RunInfo = NO_RUN_INFO,
  ): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO benchmark_results (engine, voice_id, language, seconds_per_kchar, rtf,
         encode_factor, model_load_ms, throughput, sample_chars, sample_audio_seconds, cpu_count,
         cpu_model, text_version, measured_at, load_start, load_end, load_attempt, run_seconds)
       VALUES (@engine, @voiceId, @language, @secondsPerKChar, @rtf, @encodeFactor, @modelLoadMs,
         @throughput, @sampleChars, @sampleAudioSeconds, @cpuCount, @cpuModel, @textVersion, @measuredAt,
         @loadStart, @loadEnd, @loadAttempt, @seconds)`,
    );
    const forget = this.db.prepare("DELETE FROM speed_learning WHERE engine = ? AND voice_id = ?");
    this.db.transaction(() => {
      for (const m of measurements) {
        // A run that again began on a busy computer, on the same machine, counts as another attempt.
        const before = this.get(m.engine, m.voiceId);
        const sameMachine =
          before?.cpuCount === machine.cpuCount && before.cpuModel === machine.cpuModel;
        const busyNow = wasBusy({ loadStart: run.loadStart, cpuCount: machine.cpuCount });
        const loadAttempt =
          busyNow && before && sameMachine && wasBusy(before) ? before.loadAttempt + 1 : 1;
        insert.run({
          ...m,
          throughput: JSON.stringify(m.throughput),
          ...machine,
          ...run,
          loadAttempt,
          textVersion,
          measuredAt,
        });
        forget.run(m.engine, m.voiceId);
      }
    })();
  }
}
