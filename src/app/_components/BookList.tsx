"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { getBooks, type BookSummary } from "../_lib/api";
import { libraryIsBusy, libraryStatus } from "../_lib/book-status";
import { UPLOAD_BUTTON_ID } from "../_lib/focus";
import { languageName } from "../_lib/format";
import { BookCover } from "./BookCover";
import { Button } from "./Button";
import { DeleteBookDialog } from "./DeleteBookDialog";
import { useLiveEvents, useLiveStatus } from "../_lib/events";
import { patchLibrary } from "../_lib/live-patch";
import { usePoll } from "../_lib/use-poll";
import { usePool } from "../_lib/pool-store";
import { Notice } from "./Notice";
import { ProgressBar } from "./ProgressBar";

const POLL_MS = 3000;

const QUIET = "mt-12 text-ink-muted";

/** Remounts the shelf on "Try again", which loads the books from scratch. */
export function BookList() {
  const [attempt, setAttempt] = useState(0);
  return <Shelf key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Shelf({ onRetry }: { onRetry: () => void }) {
  const live = useLiveStatus() === "live";
  const {
    data: books,
    error,
    stale,
    patch,
    update,
  } = usePoll({
    load: getBooks,
    keepPolling: libraryIsBusy,
    intervalMs: POLL_MS,
    live,
  });
  useLiveEvents(
    useCallback((event, seq) => patch((current) => patchLibrary(current, event), seq), [patch]),
  );
  const poolPaused = usePool()?.state === "paused";
  const [deleting, setDeleting] = useState<BookSummary | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  if (books === null && error === null) {
    return (
      <p className={QUIET} role="status">
        Loading your library…
      </p>
    );
  }

  if (books === null && error !== null) {
    return (
      <div className={QUIET} role="alert">
        <p className="text-danger">{error.message}</p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (books === null) return null;

  if (books.length === 0) {
    return (
      <Notice title="The shelf is empty">
        <p>
          Add an EPUB above. You will see its chapters first, and can start listening to chapter one
          while the rest is still being read aloud.
        </p>
      </Notice>
    );
  }

  return (
    <section aria-labelledby="library-title" className="mt-12">
      <h2
        id="library-title"
        className="text-[0.8rem] font-semibold tracking-[0.08em] text-ink-muted uppercase"
        ref={heading}
        tabIndex={-1}
      >
        Library
      </h2>
      {stale && <p className={QUIET}>Lost contact with the server. Trying again…</p>}
      <ul className="mt-2">
        {books.map((book) => (
          <li key={book.id} className="flex gap-4 border-t border-rule py-[1.1rem] last:border-b">
            <BookCover id={book.id} title={book.title} hasCover={book.hasCover} size="small" />
            <div className="grid min-w-0 flex-1 content-start gap-[0.15rem]">
              <Link
                href={book.status === "ready" ? `/books/${book.id}/preview` : `/books/${book.id}`}
                className="font-serif text-[1.2rem] leading-[1.3] font-semibold text-ink no-underline wrap-anywhere hover:text-accent hover:underline"
              >
                {book.title}
              </Link>
              <p className="text-[0.9rem] text-ink-muted wrap-anywhere">
                {[book.author, languageName(book.language)].filter(Boolean).join(" · ")}
              </p>
              <p className="text-[0.9rem] text-ink wrap-anywhere">
                {libraryStatus(book, poolPaused)}
              </p>
              {(book.status === "converting" || book.status === "paused") && (
                <ProgressBar
                  thin
                  value={book.chapterCount === 0 ? 0 : book.doneCount / book.chapterCount}
                  label={`Progress of ${book.title}`}
                />
              )}
              <div className="mt-[0.4rem] flex">
                <Button
                  size="small"
                  variant="outlineDanger"
                  aria-label={`Delete ${book.title}`}
                  onClick={() => setDeleting(book)}
                >
                  Delete
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <DeleteBookDialog
        book={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setDeleting(null);
          let remaining = 0;
          update((current) => {
            const next = current.filter((book) => book.id !== id);
            remaining = next.length;
            return next;
          });
          // After the dialog has closed: the button that opened it is gone, so focus would be lost.
          // With no books left the heading goes too, and the way to add one is the next best place.
          requestAnimationFrame(() =>
            (remaining > 0 ? heading.current : document.getElementById(UPLOAD_BUTTON_ID))?.focus(),
          );
        }}
      />
    </section>
  );
}
