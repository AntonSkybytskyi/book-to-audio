"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Poll<T> {
  data: T | null;
  /** The first load failed (or is being retried). Cleared by the next success. */
  error: ApiError | null;
  /** A refresh failed but older data is still shown. */
  stale: boolean;
  setData: (data: T) => void;
}

/** A lost connection or a server error may pass; a 404 will not. */
export const isTransient = (error: ApiError) => error.status === 0 || error.status >= 500;

interface Options<T> {
  /** Must be stable (`useCallback` or module level); a new function restarts polling. */
  load: () => Promise<T>;
  /** Keep refreshing while this is true for the latest data. */
  keepPolling: (data: T) => boolean;
  intervalMs: number;
}

/**
 * Loads data once, then keeps refreshing it while `keepPolling` says so.
 * A failed load or refresh is retried after the same interval when it looks
 * temporary, so one dropped request never stops the page from updating.
 */
export function usePoll<T>({ load, keepPolling, intervalMs }: Options<T>): Poll<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const loaded = useRef(false);

  const setData = useCallback((next: T) => {
    loaded.current = true;
    setDataState(next);
    setError(null);
    setStale(false);
  }, []);

  const active = data === null || keepPolling(data);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setData(next);
        if (keepPolling(next)) timer = setTimeout(tick, intervalMs);
      } catch (caught) {
        if (cancelled) return;
        const apiError =
          caught instanceof ApiError ? caught : new ApiError(0, "network", "Failed to load.");
        if (loaded.current) setStale(true);
        else setError(apiError);
        if (loaded.current || isTransient(apiError)) timer = setTimeout(tick, intervalMs);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, load, keepPolling, intervalMs, setData]);

  return { data, error, stale, setData };
}
