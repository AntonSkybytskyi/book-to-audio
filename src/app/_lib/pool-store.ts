"use client";

import { useSyncExternalStore } from "react";
import { getPool, type PoolStatus, type Snapshot } from "./api";
import { getConnectSeq, getEpoch, getLiveStatus, subscribeEvents } from "./events";
import { loadUntilCurrent, SeqGate } from "./seq-gate";

const POLL_MS = 5000;

// The pool state is shown in the banner, on the book page and in settings. One store
// loads it once and keeps it current, instead of every component fetching its own copy.
let state: PoolStatus | null = null;
const gate = new SeqGate();
let users = 0;
let stopSource: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function set(next: PoolStatus) {
  state = next;
  for (const listener of listeners) listener();
}

/** Shows a state that came from a request, such as the answer to Resume. */
export function applyPoolSnapshot(snapshot: Snapshot<PoolStatus>) {
  gate.sync(getEpoch(), getConnectSeq());
  if (gate.acceptSnapshot(snapshot.seq)) set(snapshot.data);
}

function load() {
  gate.sync(getEpoch(), getConnectSeq());
  loadUntilCurrent(getPool, gate).then(
    (snapshot) => set(snapshot.data),
    () => {
      // Shown as soon as the next event or the next poll arrives.
    },
  );
}

function start() {
  load();
  stopSource = subscribeEvents((event, seq) => {
    // The first event of every connection is the pool state at that moment.
    gate.sync(getEpoch(), getConnectSeq());
    if (event.type !== "pool" || !gate.acceptEvent(seq)) return;
    set({
      state: event.state,
      error: event.error,
      cause: event.cause,
      workers: event.workers,
      activeWorkers: event.activeWorkers,
      held: event.held,
    });
  });
  // While the stream is down, poll.
  timer = setInterval(() => {
    if (getLiveStatus() !== "live") load();
  }, POLL_MS);
}

function stop() {
  stopSource?.();
  stopSource = null;
  clearInterval(timer);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (users++ === 0) start();
  return () => {
    listeners.delete(listener);
    if (--users === 0) stop();
  };
}

/** The pool state, or null until it has loaded. */
export function usePool(): PoolStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}
