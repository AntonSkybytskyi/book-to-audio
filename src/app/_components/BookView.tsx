"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { audioUrl, type Book } from "../_lib/api";
import { formatClock, pluralize } from "../_lib/format";
import { useBook } from "../_lib/use-book";
import { BookHeader } from "./BookHeader";
import { ChapterRow } from "./ChapterRow";
import { LoadState } from "./LoadState";
import { ProgressBar } from "./ProgressBar";
import styles from "./BookView.module.css";
import shared from "./shared.module.css";

/** Overall progress: finished chapters count fully, running ones by their own progress. */
function overallProgress(book: Book): number {
  if (book.chapters.length === 0) return 0;
  const sum = book.chapters.reduce(
    (total, c) => total + (c.status === "done" ? 1 : c.status === "generating" ? c.progress : 0),
    0,
  );
  return sum / book.chapters.length;
}

function summary(book: Book): string {
  const total = pluralize(book.chapterCount, "chapter");
  switch (book.status) {
    case "ready":
      return "Not converted yet.";
    case "converting":
      return `Converting: ${book.doneCount} of ${total} ready.`;
    case "paused":
      return `Paused: ${book.doneCount} of ${total} ready.`;
    case "done":
      return `All ${total} are ready, ${formatClock(book.durationSeconds)} in total.`;
    case "done_with_errors":
      return `Finished with ${pluralize(book.failedCount, "failed chapter")}. ${book.doneCount} of ${total} are ready.`;
  }
}

export function BookView({ id }: { id: string }) {
  const { data: book, error, stale } = useBook(id);
  const audio = useRef<HTMLAudioElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  if (!book) return <LoadState error={error} />;

  const onPlayFailed = (reason: unknown) => {
    // Starting a new chapter interrupts the previous load; that is not an error.
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    setPlaying(false);
    setCurrent(null); // So the next click loads the chapter again instead of resuming a dead one.
    setPlaybackError("This chapter could not be played in your browser.");
  };

  // One shared <audio> element, so only one chapter can play at a time.
  const toggle = (position: number) => {
    const element = audio.current;
    if (!element) return;
    setPlaybackError(null);
    if (current === position) {
      if (element.paused) void element.play().catch(onPlayFailed);
      else element.pause();
      return;
    }
    element.src = audioUrl(id, position);
    setCurrent(position);
    void element.play().catch(onPlayFailed);
  };

  return (
    <div className={shared.page}>
      <BookHeader
        id={book.id}
        title={book.title}
        author={book.author}
        hasCover={book.hasCover}
        language={book.language}
      />

      <section className={styles.progress} aria-label="Conversion progress">
        {book.status !== "ready" && (
          <ProgressBar value={overallProgress(book)} label="Overall conversion progress" />
        )}
        <p className={styles.summary} role="status" aria-live="polite">
          {summary(book)}
        </p>
        {book.status === "ready" && (
          <Link href={`/books/${book.id}/preview`} className={`${shared.button} ${styles.cta}`}>
            Review and convert
          </Link>
        )}
        {stale && <p className={styles.stale}>Lost contact with the server. Trying again…</p>}
      </section>

      <p className={shared.error} role="alert">
        {playbackError}
      </p>

      <ol className={styles.chapters} aria-label="Chapters">
        {book.chapters.map((chapter) => (
          <ChapterRow
            key={chapter.position}
            chapter={chapter}
            current={current === chapter.position}
            playing={current === chapter.position && playing}
            onToggle={toggle}
          />
        ))}
      </ol>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- spoken audio, no captions exist */}
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(null);
        }}
        onError={() => {
          if (audio.current?.getAttribute("src")) {
            setPlaying(false);
            setCurrent(null);
            setPlaybackError("This chapter could not be loaded. Click play to try again.");
          }
        }}
      />
    </div>
  );
}
