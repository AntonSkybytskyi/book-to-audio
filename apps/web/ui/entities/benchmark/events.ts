import type { StreamEvent } from "@/ui/shared/api/events";
import type { BenchmarkStatus } from "./api";

/** The speed test started, moved on or ended. */
export interface BenchmarkEvent extends BenchmarkStatus {
  type: "benchmark";
}

export const isBenchmarkEvent = (event: StreamEvent): event is BenchmarkEvent =>
  event.type === "benchmark";
