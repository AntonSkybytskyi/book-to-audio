"use client";

import { useCallback } from "react";
import { getBook, type Book } from "./api";
import { usePoll, type Poll } from "./use-poll";

const POLL_MS = 2000;

const isConverting = (book: Book) => book.status === "converting";

/** Loads a book and, while it is converting, refreshes it every 2 seconds. */
export function useBook(id: string): Poll<Book> {
  const load = useCallback(() => getBook(id), [id]);
  return usePoll({ load, keepPolling: isConverting, intervalMs: POLL_MS });
}
