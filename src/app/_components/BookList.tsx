"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { getBooks, type BookSummary } from "../_lib/api";
import { libraryIsBusy, libraryStatus } from "../_lib/book-status";
import { cx } from "../_lib/cx";
import { UPLOAD_BUTTON_ID } from "../_lib/focus";
import { languageName } from "../_lib/format";
import { BookCover } from "./BookCover";
import { DeleteBookDialog } from "./DeleteBookDialog";
import { useLiveEvents, useLiveStatus } from "../_lib/events";
import { patchLibrary } from "../_lib/live-patch";
import { usePoll } from "../_lib/use-poll";
import { ProgressBar } from "./ProgressBar";
import styles from "./BookList.module.css";
import shared from "./shared.module.css";

const POLL_MS = 3000;

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
  const [deleting, setDeleting] = useState<BookSummary | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  if (books === null && error === null) {
    return (
      <p className={styles.quiet} role="status">
        Loading your library…
      </p>
    );
  }

  if (books === null && error !== null) {
    return (
      <div className={styles.quiet} role="alert">
        <p className={shared.error}>{error.message}</p>
        <button type="button" className={`${shared.button} ${shared.quiet}`} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (books === null) return null;

  if (books.length === 0) {
    return (
      <div className={shared.notice}>
        <h2 className={shared.noticeTitle}>The shelf is empty</h2>
        <p className={shared.noticeBody}>
          Add an EPUB above. You will see its chapters first, and can start listening to chapter one
          while the rest is still being read aloud.
        </p>
      </div>
    );
  }

  return (
    <section aria-labelledby="library-title" className={styles.library}>
      <h2 id="library-title" className={styles.heading} ref={heading} tabIndex={-1}>
        Library
      </h2>
      {stale && <p className={styles.quiet}>Lost contact with the server. Trying again…</p>}
      <ul className={styles.list}>
        {books.map((book) => (
          <li key={book.id} className={styles.item}>
            <BookCover id={book.id} title={book.title} hasCover={book.hasCover} size="small" />
            <div className={styles.text}>
              <Link
                href={book.status === "ready" ? `/books/${book.id}/preview` : `/books/${book.id}`}
                className={styles.title}
              >
                {book.title}
              </Link>
              <p className={styles.meta}>
                {[book.author, languageName(book.language)].filter(Boolean).join(" · ")}
              </p>
              <p className={styles.status}>{libraryStatus(book)}</p>
              {(book.status === "converting" || book.status === "paused") && (
                <ProgressBar
                  thin
                  value={book.chapterCount === 0 ? 0 : book.doneCount / book.chapterCount}
                  label={`Progress of ${book.title}`}
                />
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={cx(shared.button, shared.small, shared.outlineDanger)}
                  aria-label={`Delete ${book.title}`}
                  onClick={() => setDeleting(book)}
                >
                  Delete
                </button>
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
