"use client";

import { useCallback } from "react";
import { getBenchmark, type BenchmarkInfo } from "./api";
import { isBenchmarkEvent } from "./events";
import { benchmarkBusy, patchBenchmark } from "./benchmark";
import { useLiveEvents, useLiveStatus } from "@/ui/shared/api/events";
import { usePoll, type Poll } from "@/ui/shared/api/use-poll";

const POLL_MS = 2000;

/** The speed test's results and progress, kept current by live events (or by polling while it runs). */
export function useBenchmark(): Poll<BenchmarkInfo> {
  const live = useLiveStatus() === "live";
  const poll = usePoll<BenchmarkInfo>({
    load: getBenchmark,
    keepPolling: benchmarkBusy,
    intervalMs: POLL_MS,
    live,
  });
  const { patch } = poll;
  useLiveEvents(
    useCallback(
      (event, seq) => {
        if (isBenchmarkEvent(event)) patch((current) => patchBenchmark(current, event), seq);
      },
      [patch],
    ),
  );
  return poll;
}
