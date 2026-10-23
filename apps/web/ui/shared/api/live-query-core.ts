import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getConnectSeq, getEpoch } from "./events";
import { gateFor } from "./query-client";
import type { Snapshot } from "./request";
import { loadUntilCurrent } from "./seq-gate";

/**
 * Every load and every live event has a sequence number. A load that is older than an
 * event already applied is thrown away and repeated, and an event that a load already
 * includes is skipped, so a slow response cannot undo newer progress.
 */

/** The query function: loads until the answer is current. */
export function loadCurrent<T>(
  client: QueryClient,
  key: QueryKey,
  load: () => Promise<Snapshot<T>>,
): Promise<T> {
  const gate = gateFor(client, key);
  gate.sync(getEpoch(), getConnectSeq());
  return loadUntilCurrent(load, gate).then((snapshot) => snapshot.data);
}

/**
 * Applies a live event to the data in the cache. `change` returns the new data, the same
 * object for no change, or null when it cannot tell and the data should be loaded again.
 * Returns what happened, so the caller can reload.
 */
export function applyLiveEvent<T>(
  client: QueryClient,
  key: QueryKey,
  change: (current: T) => T | null,
  seq: number,
): "applied" | "skipped" | "reload" {
  const gate = gateFor(client, key);
  gate.sync(getEpoch(), getConnectSeq());
  const current = client.getQueryData<T>(key);
  if (current === undefined) {
    gate.noteEarlyEvent(seq);
    return "skipped";
  }
  if (!gate.acceptEvent(seq)) return "skipped";
  const next = change(current);
  if (next === null) return "reload";
  if (next !== current) client.setQueryData(key, next);
  return "applied";
}

/** Shows data that came from a request, such as the answer to Resume, unless an event is newer. */
export function applySnapshot<T>(client: QueryClient, key: QueryKey, snapshot: Snapshot<T>): void {
  const gate = gateFor(client, key);
  gate.sync(getEpoch(), getConnectSeq());
  if (gate.acceptSnapshot(snapshot.seq)) client.setQueryData(key, snapshot.data);
}
