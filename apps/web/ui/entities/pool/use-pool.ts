"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useLiveEvents } from "@/ui/shared/api/events";
import { applySnapshot } from "@/ui/shared/api/live-query-core";
import type { Snapshot } from "@/ui/shared/api/request";
import { useLiveQuery } from "@/ui/shared/api/use-live-query";
import { getPool, type PoolStatus } from "./api";
import { isPoolEvent } from "./events";

const POLL_MS = 5000;
const POOL_KEY = ["pool"] as const;

/**
 * The pool state, or null until it has loaded. It is shown in the banner, on the book page
 * and in settings; they share one query, so it is loaded once and kept current for all.
 */
export function usePool(): PoolStatus | null {
  const { data, patch } = useLiveQuery<PoolStatus>({
    key: POOL_KEY,
    load: getPool,
    keepPolling: () => true,
    intervalMs: POLL_MS,
  });
  useLiveEvents(
    useCallback(
      (event, seq) => {
        if (!isPoolEvent(event)) return;
        patch(
          () => ({
            state: event.state,
            error: event.error,
            cause: event.cause,
            workers: event.workers,
            activeWorkers: event.activeWorkers,
            held: event.held,
          }),
          seq,
        );
      },
      [patch],
    ),
  );
  return data;
}

/** Shows a state that came from a request, such as the answer to Resume. */
export function useApplyPoolSnapshot(): (snapshot: Snapshot<PoolStatus>) => void {
  const client = useQueryClient();
  return useCallback((snapshot) => applySnapshot(client, POOL_KEY, snapshot), [client]);
}
