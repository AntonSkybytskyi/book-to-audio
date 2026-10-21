"use client";

import Link from "next/link";
import { useState } from "react";
import { getBooks, type BookSummary } from "../_lib/api";
import { formatClock, formatMinutes, languageName, pluralize } from "../_lib/format";
import { BookCover } from "./BookCover";
import { usePoll } from "../_lib/use-poll";
import { ProgressBar } from "./ProgressBar";
import styles from "./BookList.module.css";
import shared from "./shared.module.css";

const POLL_MS = 3000;

const anyConverting = (books: BookSummary[]) => books.some((b) => b.status === "converting");

function statusText(book: BookSummary): string {
  switch (book.status) {
    case "ready":
      return `Ready to convert · about ${formatMinutes(book.estimatedMinutes)}`;
    case "converting":
      return `Converting · ${book.doneCount} of ${pluralize(book.chapterCount, "chapter")} ready`;
    case "paused":
      return `Paused · ${book.doneCount} of ${pluralize(book.chapterCount, "chapter")} ready`;
    case "done":
      return `Ready to listen · ${formatClock(book.durationSeconds)}`;
    case "done_with_errors":
      return `${pluralize(book.failedCount, "chapter")} failed · ${book.doneCount} ready`;
  }
}

/** Remounts the shelf on "Try again", which loads the books from scratch. */
export function BookList() {
  const [attempt, setAttempt] = useState(0);
  return <Shelf key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Shelf({ onRetry }: { onRetry: () => void }) {
  const {
    data: books,
    error,
    stale,
  } = usePoll({
    load: getBooks,
    keepPolling: anyConverting,
    intervalMs: POLL_MS,
  });

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
      <h2 id="library-title" className={styles.heading}>
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
              <p className={styles.status}>{statusText(book)}</p>
              {book.status === "converting" && (
                <ProgressBar
                  thin
                  value={book.chapterCount === 0 ? 0 : book.doneCount / book.chapterCount}
                  label={`Progress of ${book.title}`}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
