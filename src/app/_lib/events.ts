"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BenchmarkStatus, BookStatus, ChapterStatus, Outputs, PoolStatus } from "./api";

// Mirrors the payloads in src/server/events/bus.ts.
export interface ChapterEvent {
  type: "chapter";
  bookId: string;
  position: number;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  durationSeconds: number | null;
  chunkCount: number;
  chunksDone: number;
  /** Set when the chapter's audio was written; null in every other event. */
  audioVersion: number | null;
  /** Set when a regeneration failed and the chapter went back to done with its old audio. */
  regenError: string | null;
}

export interface BookEvent {
  type: "book";
  bookId: string;
  status: BookStatus;
  doneCount: number;
  failedCount: number;
  durationSeconds: number;
}

export interface PoolEvent extends PoolStatus {
  type: "pool";
}

export interface BookAddedEvent {
  type: "book-added";
  bookId: string;
}

export interface BookDeletedEvent {
  type: "book-deleted";
  bookId: string;
}

/** The state of a book's downloads changed. */
export interface OutputsEvent extends Outputs {
  type: "outputs";
  bookId: string;
}

/** The speed test started, moved on or ended. */
export interface BenchmarkEvent extends BenchmarkStatus {
  type: "benchmark";
}

/** The prepared text of a book was counted, so its length and conversion time can be told now. */
export interface BookCountedEvent {
  type: "book-counted";
  bookId: string;
}

export type AppEvent =
  | ChapterEvent
  | BookEvent
  | PoolEvent
  | BookAddedEvent
  | BookDeletedEvent
  | OutputsEvent
  | BenchmarkEvent
  | BookCountedEvent;

/** `live`: the stream is open and pages need not poll. `down`: poll until it comes back. */
export type LiveStatus = "connecting" | "live" | "down";

/** Called with every event and its sequence number (higher means newer). */
export type EventListener = (event: AppEvent, seq: number) => void;

const EVENT_TYPES = [
  "chapter",
  "book",
  "pool",
  "book-added",
  "book-deleted",
  "outputs",
  "benchmark",
  "book-counted",
] as const;
const RECONNECT_MS = 3000;

// One EventSource for the whole page, shared by everything that listens.
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let users = 0;
let status: LiveStatus = "connecting";
let connectSeq = 0;
let epoch = 0;
let reconnects = 0;
let wasDown = false;
const eventListeners = new Set<EventListener>();
const statusListeners = new Set<() => void>();

function setStatus(next: LiveStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function connect() {
  if (typeof EventSource === "undefined") {
    setStatus("down");
    return;
  }
  const stream = new EventSource("/api/events");
  source = stream;
  for (const type of EVENT_TYPES) {
    stream.addEventListener(type, (message) => {
      try {
        const { data, lastEventId } = message as MessageEvent<string>;
        const event = JSON.parse(data) as AppEvent;
        const seq = Number(lastEventId);
        // The first message of a connection is the pool state at that moment: it says
        // which events came before this connection, and means the stream is working.
        if (status !== "live") {
          connectSeq = seq;
          epoch++;
          if (wasDown) reconnects++;
          setStatus("live");
        }
        for (const listener of eventListeners) listener(event, seq);
      } catch {
        // A malformed message is skipped; the next refresh puts things right.
      }
    });
  }
  stream.addEventListener("error", () => {
    wasDown = true;
    setStatus("down");
    // The browser reconnects by itself after a drop. It gives up when the server refused
    // the stream outright, so those are retried here.
    if (stream.readyState === EventSource.CLOSED) {
      source = null;
      retryTimer = setTimeout(connect, RECONNECT_MS);
    }
  });
}

/** Opens the stream for the first user and closes it after the last. */
function acquire(): () => void {
  if (users++ === 0) connect();
  return () => {
    if (--users > 0) return;
    source?.close();
    source = null;
    clearTimeout(retryTimer);
    status = "connecting";
    wasDown = false;
  };
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  const release = acquire();
  return () => {
    statusListeners.delete(listener);
    release();
  };
}

/** Listens to events outside React. Returns the function that stops. */
export function subscribeEvents(listener: EventListener): () => void {
  eventListeners.add(listener);
  const release = acquire();
  return () => {
    eventListeners.delete(listener);
    release();
  };
}

export function getLiveStatus(): LiveStatus {
  return status;
}

/** Sequence number of the newest event that came before the current connection. */
export const getConnectSeq = () => connectSeq;

/** Changes with every new connection to the server. */
export const getEpoch = () => epoch;

/** How many times the stream came back after dropping. */
export const getReconnects = () => reconnects;

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    subscribeStatus,
    () => status,
    () => "connecting",
  );
}

/** Calls `handler` for every event from the server while the component is mounted. */
export function useLiveEvents(handler: EventListener) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => subscribeEvents((event, seq) => latest.current(event, seq)), []);
}
