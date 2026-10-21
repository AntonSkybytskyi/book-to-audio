"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Snapshot } from "./api";
import { getConnectSeq, getEpoch, getReconnects } from "./events";
import { loadUntilCurrent, SeqGate } from "./seq-gate";

export interface Poll<T> {
  data: T | null;
  /** The first load failed (or is being retried). Cleared by the next success. */
  error: ApiError | null;
  /** A refresh failed but older data is still shown. */
  stale: boolean;
  /** Shows data that came from somewhere else, such as the answer to a request that changed it. */
  setData: (data: T) => void;
  /**
   * Applies a live event, with its sequence number, to the data shown. `change` returns the
   * new data, the same object for no change, or null when it cannot tell and the data should
   * be loaded again. Events the data already includes, or has already seen, are skipped.
   */
  patch: (change: (current: T) => T | null, seq: number) => void;
  /** Loads the data again now. */
  refresh: () => void;
}

/** A lost connection or a server error may pass; a 404 will not. */
export const isTransient = (error: ApiError) => error.status === 0 || error.status >= 500;

interface Options<T> {
  /** Must be stable (`useCallback` or module level); a new function restarts polling. */
  load: () => Promise<Snapshot<T>>;
  /** Keep refreshing while this is true for the latest data. */
  keepPolling: (data: T) => boolean;
  intervalMs: number;
  /** The live event stream is open: load once, then rely on events instead of polling. */
  live?: boolean;
}

/**
 * Loads data once, then keeps refreshing it while `keepPolling` says so, unless live
 * events are arriving. A failed load or refresh is retried after the same interval when
 * it looks temporary, so one dropped request never stops the page.
 *
 * Every load and every event has a sequence number. A load that is older than an event
 * already applied is thrown away and repeated, and an event that a load already
 * includes is skipped, so a slow response cannot undo newer progress. When the stream
 * opens, the data is loaded again only if events came between the last load and then;
 * when it comes back after a drop, always.
 */
export function usePoll<T>({ load, keepPolling, intervalMs, live = false }: Options<T>): Poll<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const loaded = useRef(false);
  const latest = useRef<T | null>(null);
  const mounted = useRef(true);
  const gate = useRef(new SeqGate());
  /** The connection that the data was last checked against. */
  const checkedConnection = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  const reconnects = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setData = useCallback((next: T) => {
    loaded.current = true;
    latest.current = next;
    setDataState(next);
    setError(null);
    setStale(false);
  }, []);

  /** Loads until the answer is current, and shows it. */
  const loadCurrent = useCallback(async () => {
    gate.current.sync(getEpoch(), getConnectSeq());
    const snapshot = await loadUntilCurrent(load, gate.current);
    if (!mounted.current) return snapshot;
    setData(snapshot.data);
    // Events that came while nothing was shown yet could not be applied; ask again for them.
    if (gate.current.takeCatchUp(snapshot.seq)) {
      queueMicrotask(() => refreshRef.current());
    }
    return snapshot;
  }, [load, setData]);

  const refresh = useCallback(() => {
    loadCurrent().catch(() => {
      // Events keep coming and the next change tries again.
    });
  }, [loadCurrent]);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const patch = useCallback(
    (change: (current: T) => T | null, seq: number) => {
      gate.current.sync(getEpoch(), getConnectSeq());
      if (latest.current === null) {
        gate.current.noteEarlyEvent(seq);
        return;
      }
      if (!gate.current.acceptEvent(seq)) return;
      const next = change(latest.current);
      if (next === null) refresh();
      else if (next !== latest.current) setData(next);
    },
    [refresh, setData],
  );

  const active = data === null || keepPolling(data);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const snapshot = await loadCurrent();
        if (cancelled) return;
        if (live) {
          // Events may have come between this load and the stream opening; look once per connection.
          const connection = getEpoch();
          if (
            checkedConnection.current !== connection &&
            snapshot.seq > 0 &&
            snapshot.seq < getConnectSeq()
          ) {
            checkedConnection.current = connection;
            timer = setTimeout(tick, 0);
          }
        } else if (keepPolling(snapshot.data)) {
          timer = setTimeout(tick, intervalMs);
        }
      } catch (caught) {
        if (cancelled) return;
        const apiError =
          caught instanceof ApiError ? caught : new ApiError(0, "network", "Failed to load.");
        if (loaded.current) {
          if (live) return; // Events carry on; no need to complain.
          setStale(true);
          timer = setTimeout(tick, intervalMs);
        } else {
          setError(apiError);
          if (isTransient(apiError)) timer = setTimeout(tick, intervalMs);
        }
      }
    };
    // With the stream open and data on screen there is nothing to fetch for a page that is polling.
    if (!(live && loaded.current)) void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, live, loadCurrent, keepPolling, intervalMs]);

  // The stream opened. Load again if it came back after a drop, or if events came before it
  // that the data does not include. This also covers data that is no longer being polled.
  useEffect(() => {
    if (!live || !loaded.current) return;
    gate.current.sync(getEpoch(), getConnectSeq());
    const back = getReconnects() > reconnects.current;
    reconnects.current = getReconnects();
    const behind = gate.current.snapshotSeq > 0 && gate.current.snapshotSeq < getConnectSeq();
    if (back || behind) {
      checkedConnection.current = getEpoch();
      refresh();
    }
  }, [live, refresh]);

  return { data, error, stale, setData, patch, refresh };
}
