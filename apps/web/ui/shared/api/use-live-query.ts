"use client";

import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { getConnectSeq, getEpoch, getReconnects, useLiveStatus } from "./events";
import { applyLiveEvent, loadCurrent } from "./live-query-core";
import { gateFor, isTransient } from "./query-client";
import { ApiError, type Snapshot } from "./request";

export interface Poll<T> {
  data: T | null;
  /** The first load failed (or is being retried). Cleared by the next success. */
  error: ApiError | null;
  /** A refresh failed but older data is still shown. */
  stale: boolean;
  /** Data was shown, and the server now says it does not exist (it was deleted). */
  gone: boolean;
  /** Shows data that came from somewhere else, such as the answer to a request that changed it. */
  setData: (data: T) => void;
  /** Changes the data shown, starting from the newest data (not from what a handler saw when it rendered). */
  update: (change: (current: T) => T) => void;
  /**
   * Applies a live event, with its sequence number, to the data shown. `change` returns the
   * new data, the same object for no change, or null when it cannot tell and the data should
   * be loaded again. Events the data already includes, or has already seen, are skipped.
   */
  patch: (change: (current: T) => T | null, seq: number) => void;
  /** Loads the data again now. */
  refresh: () => void;
}

interface Options<T> {
  key: QueryKey;
  load: () => Promise<Snapshot<T>>;
  /** Keep refreshing while this is true for the latest data. */
  keepPolling: (data: T) => boolean;
  intervalMs: number;
}

/**
 * Loads data once, then keeps refreshing it while `keepPolling` says so, unless live
 * events are arriving. A failed load or refresh is retried after the same interval when
 * it looks temporary, so one dropped request never stops the page. When the stream opens,
 * the data is loaded again only if events came between the last load and then; when it
 * comes back after a drop, always.
 */
export function useLiveQuery<T>({ key, load, keepPolling, intervalMs }: Options<T>): Poll<T> {
  const client = useQueryClient();
  const live = useLiveStatus() === "live";
  const loadRef = useRef(load);
  const keepPollingRef = useRef(keepPolling);
  useEffect(() => {
    loadRef.current = load;
    keepPollingRef.current = keepPolling;
  });

  const query = useQuery<T, ApiError>({
    queryKey: key,
    queryFn: () => loadCurrent(client, key, () => loadRef.current()),
    retry: (_count, error) => isTransient(error),
    retryDelay: intervalMs,
    refetchInterval: (current) => {
      if (live) return false;
      // What failed for good (a 404) will not come back by asking again.
      if (current.state.error && !isTransient(current.state.error)) return false;
      const data = current.state.data;
      return data === undefined || keepPollingRef.current(data) ? intervalMs : false;
    },
  });
  const { data, refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);

  const failure = query.error ?? query.failureReason;
  const error =
    failure instanceof ApiError
      ? failure
      : failure
        ? new ApiError(0, "network", "Failed to load.")
        : null;
  const loaded = data !== undefined;
  const gone = loaded && query.error instanceof ApiError && query.error.status === 404;

  const patch = useCallback(
    (change: (current: T) => T | null, seq: number) => {
      if (applyLiveEvent(client, key, change, seq) === "reload") refresh();
    },
    // `key` is a new array each render, but means the same query.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [client, JSON.stringify(key), refresh],
  );

  const setData = useCallback(
    (next: T) => void client.setQueryData(key, next),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [client, JSON.stringify(key)],
  );

  const update = useCallback(
    (change: (current: T) => T) => {
      const current = client.getQueryData<T>(key);
      if (current !== undefined) client.setQueryData(key, change(current));
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [client, JSON.stringify(key)],
  );

  // After a load: ask again for events that came before there was anything to apply them to,
  // and, with the stream open, look once per connection for events between the load and the stream.
  const checkedConnection = useRef(0);
  useEffect(() => {
    if (!loaded) return;
    const gate = gateFor(client, key);
    if (gate.takeCatchUp(gate.snapshotSeq)) {
      refresh();
      return;
    }
    if (!live) return;
    const connection = getEpoch();
    if (
      checkedConnection.current !== connection &&
      gate.snapshotSeq > 0 &&
      gate.snapshotSeq < getConnectSeq()
    ) {
      checkedConnection.current = connection;
      refresh();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [query.dataUpdatedAt]);

  // The stream opened. Load again if it came back after a drop, or if events came before it
  // that the data does not include. This also covers data that is no longer being polled.
  const reconnects = useRef(0);
  useEffect(() => {
    if (!live || !loaded) return;
    const gate = gateFor(client, key);
    gate.sync(getEpoch(), getConnectSeq());
    const back = getReconnects() > reconnects.current;
    reconnects.current = getReconnects();
    const behind = gate.snapshotSeq > 0 && gate.snapshotSeq < getConnectSeq();
    if (back || behind) {
      checkedConnection.current = getEpoch();
      refresh();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return {
    data: data ?? null,
    error: loaded ? null : error,
    stale: loaded && !live && failure !== null,
    gone,
    setData,
    update,
    patch,
    refresh,
  };
}
