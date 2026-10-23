"use client";

import { useCallback, useState } from "react";
import { getBook, type Book } from "./api";
import { bookIsBusy } from "./book-status";
import { useLiveEvents } from "@/ui/shared/api/events";
import { isLiveEvent, patchBook } from "./live-patch";
import { useLiveQuery, type Poll } from "@/ui/shared/api/use-live-query";

const POLL_MS = 2000;

/**
 * Loads a book and keeps it current: from live events when the stream is open,
 * otherwise by refreshing every 2 seconds while work is going on. `deleted` turns true
 * when the book was deleted (here or elsewhere) while the page was open.
 */
export function useBook(id: string): Poll<Book> & { deleted: boolean } {
  const load = useCallback(() => getBook(id), [id]);
  const poll = useLiveQuery({
    key: ["book", id],
    load,
    keepPolling: bookIsBusy,
    intervalMs: POLL_MS,
  });
  const [deletedByEvent, setDeletedByEvent] = useState(false);
  const { patch } = poll;
  useLiveEvents(
    useCallback(
      (event, seq) => {
        if (!isLiveEvent(event)) return;
        if (event.type === "book-deleted" && event.bookId === id) setDeletedByEvent(true);
        else patch((book) => patchBook(book, event), seq);
      },
      [id, patch],
    ),
  );
  return { ...poll, deleted: deletedByEvent || poll.gone };
}
