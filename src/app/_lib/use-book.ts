"use client";

import { useCallback, useState } from "react";
import { getBook, type Book } from "./api";
import { bookIsBusy } from "./book-status";
import { useLiveEvents, useLiveStatus } from "./events";
import { patchBook } from "./live-patch";
import { usePoll, type Poll } from "./use-poll";

const POLL_MS = 2000;

/**
 * Loads a book and keeps it current: from live events when the stream is open,
 * otherwise by refreshing every 2 seconds while work is going on. `deleted` turns true
 * when the book was deleted (here or elsewhere) while the page was open.
 */
export function useBook(id: string): Poll<Book> & { deleted: boolean } {
  const load = useCallback(() => getBook(id), [id]);
  const live = useLiveStatus() === "live";
  const poll = usePoll({ load, keepPolling: bookIsBusy, intervalMs: POLL_MS, live });
  const [deletedByEvent, setDeletedByEvent] = useState(false);
  const { patch } = poll;
  useLiveEvents(
    useCallback(
      (event, seq) => {
        if (event.type === "book-deleted" && event.bookId === id) setDeletedByEvent(true);
        else patch((book) => patchBook(book, event), seq);
      },
      [id, patch],
    ),
  );
  return { ...poll, deleted: deletedByEvent || poll.gone };
}
