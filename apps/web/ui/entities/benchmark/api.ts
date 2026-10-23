import type { ThroughputPoint } from "@book-to-audio/contracts";
import { request, requestSnapshot } from "@/ui/shared/api/request";

export type BenchmarkState = "idle" | "waiting" | "running" | "cancelling";

/** The state of the speed test. Mirrors `BenchmarkStatus` in src/server/benchmark/status.ts. */
export interface BenchmarkStatus {
  state: BenchmarkState;
  trigger: "startup" | "manual" | null;
  progress: number;
  language: string | null;
  startedAt: string | null;
  outcome: "completed" | "cancelled" | "failed" | null;
  error: string | null;
  /** How long a run is expected to take, from the last one. */
  expectedSeconds: number;
}

/** One voice's result. Mirrors `ResultView` in src/server/benchmark/view.ts. */
export interface BenchmarkResult {
  secondsPerKChar: number;
  rtf: number;
  encodeFactor: number | null;
  modelLoadSeconds: number;
  throughput: ThroughputPoint[];
  sampleChars: number;
  sampleAudioSeconds: number;
  measuredAt: string;
  novelAudioSeconds: number;
  novelConvertSeconds: number;
  outdated: boolean;
  /** The load average when the run began and ended; the end includes the run itself. */
  loadStart: number | null;
  loadEnd: number | null;
  /** The computer was busier than it has cores when the run began. */
  busy: boolean;
}

export interface BenchmarkInfo extends BenchmarkStatus {
  rows: { language: string; voiceId: string; result: BenchmarkResult | null }[];
  workers: number;
  maxWorkers: number;
  suggestedWorkers: number | null;
  machine: { cpuCount: number; cpuModel: string };
  needsRun: boolean;
}

export const getBenchmark = () => requestSnapshot<BenchmarkInfo>("/api/benchmark");
export const startBenchmark = () => request<BenchmarkInfo>("/api/benchmark", { method: "POST" });
export const cancelBenchmark = () => request<BenchmarkInfo>("/api/benchmark", { method: "DELETE" });
