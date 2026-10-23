"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { audioUrl, regenerateChapter } from "@/ui/entities/book/api";
import { bookSummary, overallProgress } from "@/ui/entities/book/book-status";
import { speedTestSecondsLeft } from "@/ui/entities/benchmark/benchmark";
import { bookTimeLeft } from "@/ui/entities/book/time-left";
import { useBenchmark } from "@/ui/entities/benchmark/use-benchmark";
import { usePool } from "@/ui/entities/pool/use-pool";
import { useBook } from "@/ui/entities/book/use-book";
import { BookControls } from "./BookControls";
import { BookDeleted } from "@/ui/entities/book/BookDeleted";
import { BookHeader } from "@/ui/entities/book/BookHeader";
import { Button } from "@/ui/shared/ui/Button";
import { ChapterRow } from "./ChapterRow";
import { DeleteBookDialog } from "@/ui/entities/book/DeleteBookDialog";
import { Downloads } from "./Downloads";
import { LoadState } from "@/ui/shared/ui/LoadState";
import { Page } from "@/ui/shared/ui/Page";
import { ProgressBar } from "@/ui/shared/ui/ProgressBar";
import { RegenerateChapterDialog } from "./RegenerateChapterDialog";

export function BookView({ id }: { id: string }) {
  const router = useRouter();
  const { data: book, error, stale, deleted, refresh } = useBook(id);
  const pool = usePool();
  const { data: speedTest } = useBenchmark();
  const audio = useRef<HTMLAudioElement>(null);
  /** The chapter and audio version that the shared <audio> element has loaded. */
  const loaded = useRef<{ position: number; version: number } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState<number | null>(null);

  const regenerate = useCallback(
    async (position: number) => {
      const result = await regenerateChapter(id, position);
      refresh();
      return result;
    },
    [id, refresh],
  );

  if (deleted) return <BookDeleted />;
  if (!book) return <LoadState error={error} />;

  const timeLeft = bookTimeLeft(book, pool, speedTestSecondsLeft(speedTest));

  const onPlayFailed = (reason: unknown) => {
    // Starting a new chapter interrupts the previous load; that is not an error.
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    setPlaying(false);
    setCurrent(null); // So the next click loads the chapter again instead of resuming a dead one.
    loaded.current = null;
    setPlaybackError("This chapter could not be played in your browser.");
  };

  // One shared <audio> element, so only one chapter can play at a time.
  const toggle = (position: number) => {
    const element = audio.current;
    const chapter = book.chapters.find((c) => c.position === position);
    if (!element || !chapter) return;
    setPlaybackError(null);
    if (!element.paused && current === position) {
      element.pause();
      return;
    }
    const same = loaded.current?.position === position;
    // The audio was replaced since it was loaded: start the new file, never the old one.
    if (same && loaded.current?.version === chapter.audioVersion) {
      setCurrent(position);
      void element.play().catch(onPlayFailed);
      return;
    }
    element.src = audioUrl(id, position, chapter.audioVersion);
    loaded.current = { position, version: chapter.audioVersion };
    setCurrent(position);
    void element.play().catch(onPlayFailed);
  };

  return (
    <Page>
      <BookHeader
        id={book.id}
        title={book.title}
        author={book.author}
        hasCover={book.hasCover}
        language={book.language}
      />

      <section className="mt-8 mb-6 grid gap-[0.6rem]" aria-label="Conversion progress">
        {book.status !== "ready" && (
          <ProgressBar value={overallProgress(book)} label="Overall conversion progress" />
        )}
        <p className="tabular-nums" role="status" aria-live="polite">
          {bookSummary(book, pool?.state === "paused")}
        </p>
        {timeLeft && <p className="text-[0.95rem] text-ink-muted tabular-nums">{timeLeft}</p>}
        {book.status === "ready" && (
          <Button href={`/books/${book.id}/preview`} className="justify-self-start">
            Review and convert
          </Button>
        )}
        {stale && (
          <p className="text-[0.9rem] text-ink-muted">
            Lost contact with the server. Trying again…
          </p>
        )}
      </section>

      <BookControls book={book} onChanged={refresh} onDelete={() => setDeleting(true)} />

      <Downloads book={book} onChanged={refresh} />

      <p className="text-danger" role="alert">
        {playbackError}
      </p>

      <ol className="border-t border-rule" aria-label="Chapters">
        {book.chapters.map((chapter) => (
          <ChapterRow
            key={chapter.position}
            chapter={chapter}
            bookPaused={book.status === "paused"}
            current={current === chapter.position}
            playing={current === chapter.position && playing}
            onToggle={toggle}
            onRegenerate={regenerate}
            onConfirmRegenerate={setAsking}
          />
        ))}
      </ol>

      <RegenerateChapterDialog
        chapter={book.chapters.find((c) => c.position === asking) ?? null}
        onRegenerate={regenerate}
        onClose={() => setAsking(null)}
      />
      <DeleteBookDialog
        book={deleting ? { id: book.id, title: book.title } : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => router.push("/")}
      />

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
          if (!audio.current?.getAttribute("src")) return;
          // A later request for a replaced file is refused by the server (410), which the
          // element reports as a plain error: tell that apart from a broken file.
          const wanted = book.chapters.find((c) => c.position === loaded.current?.position);
          const replaced = wanted !== undefined && wanted.audioVersion !== loaded.current?.version;
          setPlaying(false);
          setCurrent(null);
          loaded.current = null; // The next play loads the current version from the start.
          if (replaced) {
            setPlaybackError("A new version of this chapter is ready. Press play to hear it.");
          } else {
            setPlaybackError("This chapter could not be loaded. Click play to try again.");
            refresh(); // It may have been replaced a moment ago, and the page does not know yet.
          }
        }}
      />
    </Page>
  );
}
