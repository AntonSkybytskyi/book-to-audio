import type { BenchmarkEvent } from "@book-to-audio/contracts";
import type { StreamEvent } from "@/ui/shared/api/events";

export type { BenchmarkEvent };

export const isBenchmarkEvent = (event: StreamEvent): event is BenchmarkEvent =>
  event.type === "benchmark";
