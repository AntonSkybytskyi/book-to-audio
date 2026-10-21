"use client";

import type { Chapter } from "../_lib/api";
import {
  canPlay,
  canRegenerate,
  isFinishing,
  isRegenerating,
  regenerateLabel,
} from "../_lib/chapter";
import { cx } from "../_lib/cx";
import { formatClock } from "../_lib/format";
import { useAction } from "../_lib/use-action";
import { ProgressBar } from "./ProgressBar";
import styles from "./ChapterRow.module.css";
import shared from "./shared.module.css";

interface Props {
  chapter: Chapter;
  /** The book is paused: waiting chapters will not start until it is resumed. */
  bookPaused: boolean;
  playing: boolean;
  current: boolean;
  onToggle: (position: number) => void;
  /** Asks the server to regenerate the chapter; rejects with the server's message. */
  onRegenerate: (position: number) => Promise<unknown>;
  /** A running chapter loses its work, so the page asks first (one dialog for all rows). */
  onConfirmRegenerate: (position: number) => void;
}

function Status({ chapter, bookPaused }: { chapter: Chapter; bookPaused: boolean }) {
  const again = isRegenerating(chapter);
  switch (chapter.status) {
    case "pending":
      return null; // The book has not been converted, so there is nothing to report.
    case "queued":
      if (again) {
        return (
          <span className={styles.working}>
            {bookPaused ? "Regenerating · on hold" : "Regenerating · waiting"}
          </span>
        );
      }
      return <span className={styles.muted}>{bookPaused ? "On hold" : "Waiting"}</span>;
    case "generating":
      // Every chunk is read; what is left is joining them into the chapter's file.
      if (isFinishing(chapter)) return <span className={styles.working}>Finishing…</span>;
      return (
        <span className={styles.working}>
          {again ? "Regenerating" : "Reading aloud"} {Math.round(chapter.progress * 100)}%
        </span>
      );
    case "done":
      return <span className={styles.muted}>{formatClock(chapter.durationSeconds ?? 0)}</span>;
    case "failed":
      return <span className={styles.failed}>Failed</span>;
  }
}

export function ChapterRow({
  chapter,
  bookPaused,
  playing,
  current,
  onToggle,
  onRegenerate,
  onConfirmRegenerate,
}: Props) {
  const regenerate = useAction();
  const playable = canPlay(chapter);
  const label = `${playing ? "Pause" : "Play"} chapter ${chapter.position}, ${chapter.title}`;

  if (chapter.status === "pending") {
    return (
      <li className={styles.row}>
        <span className={styles.badge} aria-hidden="true">
          {chapter.position}
        </span>
        <p className={styles.title}>{chapter.title}</p>
      </li>
    );
  }

  const failed = chapter.status === "failed";
  const click = () =>
    chapter.status === "generating"
      ? onConfirmRegenerate(chapter.position)
      : void regenerate.run(() => onRegenerate(chapter.position));

  return (
    <li className={cx(styles.row, current && styles.current, failed && styles.failedRow)}>
      <button
        type="button"
        className={cx(styles.play, playing && styles.playing)}
        disabled={!playable}
        aria-label={playable ? label : `Chapter ${chapter.position} is not ready to play`}
        aria-pressed={playable ? playing : undefined}
        onClick={() => onToggle(chapter.position)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          {playing ? (
            <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
          ) : (
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          )}
        </svg>
      </button>

      <div className={styles.body}>
        <p className={styles.title}>
          <span className={styles.number}>{chapter.position}.</span> {chapter.title}
        </p>
        {chapter.status === "generating" && (
          <ProgressBar
            thin
            busy={isFinishing(chapter)}
            value={chapter.progress}
            label={`Chapter ${chapter.position} progress`}
          />
        )}
        {failed && chapter.error && <p className={styles.errorText}>{chapter.error}</p>}
        {chapter.status === "done" && chapter.regenError && (
          <p className={styles.errorText} role="status">
            Regeneration failed: {chapter.regenError} The previous audio was kept.
          </p>
        )}
        {failed && chapter.hasAudio && (
          <p className={styles.note}>The previous audio of this chapter can still be played.</p>
        )}
        {canRegenerate(chapter) && (
          <div className={styles.actions}>
            <button
              type="button"
              className={cx(
                shared.button,
                shared.small,
                failed ? styles.retry : cx(shared.outline, styles.quietAction),
              )}
              aria-label={regenerateLabel(chapter)}
              disabled={regenerate.busy}
              onClick={click}
            >
              {regenerate.busy ? "Starting…" : "Regenerate"}
            </button>
          </div>
        )}
        {regenerate.error && (
          <p className={shared.error} role="alert">
            {regenerate.error}
          </p>
        )}
      </div>

      <div className={styles.status}>
        <Status chapter={chapter} bookPaused={bookPaused} />
      </div>
    </li>
  );
}
