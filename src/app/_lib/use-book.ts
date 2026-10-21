"use client";

import { useCallback } from "react";
import { getBook, type Book } from "./api";
import { useLiveEvents, useLiveStatus } from "./events";
import { patchBook } from "./live-patch";
import { usePoll, type Poll } from "./use-poll";

const POLL_MS = 2000;

const isConverting = (book: Book) => book.status === "converting";

/**
 * Loads a book and keeps it current: from live events when the stream is open,
 * otherwise by refreshing every 2 seconds while it is converting.
 */
export function useBook(id: string): Poll<Book> {
  const load = useCallback(() => getBook(id), [id]);
  const live = useLiveStatus() === "live";
  const poll = usePoll({ load, keepPolling: isConverting, intervalMs: POLL_MS, live });
  const { patch } = poll;
  useLiveEvents(useCallback((event, seq) => patch((book) => patchBook(book, event), seq), [patch]));
  return poll;
}
