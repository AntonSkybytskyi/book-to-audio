import type { BenchmarkView } from "@book-to-audio/contracts";
import { request, requestSnapshot } from "@/ui/shared/api/request";

export type {
  BenchmarkState,
  BenchmarkStatus,
  ResultView as BenchmarkResult,
  BenchmarkView as BenchmarkInfo,
} from "@book-to-audio/contracts";

export const getBenchmark = () => requestSnapshot<BenchmarkView>("/api/benchmark");
export const startBenchmark = () => request<BenchmarkView>("/api/benchmark", { method: "POST" });
export const cancelBenchmark = () => request<BenchmarkView>("/api/benchmark", { method: "DELETE" });
