import type { Chapter } from "../_lib/api";
import { isFinishing } from "../_lib/chapter";
import { cx } from "../_lib/cx";
import { formatClock } from "../_lib/format";
import { ProgressBar } from "./ProgressBar";
import styles from "./ChapterRow.module.css";

interface Props {
  chapter: Chapter;
  playing: boolean;
  current: boolean;
  onToggle: (position: number) => void;
}

function Status({ chapter }: { chapter: Chapter }) {
  switch (chapter.status) {
    case "pending":
      return null; // The book has not been converted, so there is nothing to report.
    case "queued":
      return <span className={styles.muted}>Waiting</span>;
    case "generating":
      // Every chunk is read; what is left is joining them into the chapter's file.
      if (isFinishing(chapter)) return <span className={styles.working}>Finishing…</span>;
      return (
        <span className={styles.working}>Reading aloud {Math.round(chapter.progress * 100)}%</span>
      );
    case "done":
      return <span className={styles.muted}>{formatClock(chapter.durationSeconds ?? 0)}</span>;
    case "failed":
      return <span className={styles.failed}>Failed</span>;
  }
}

export function ChapterRow({ chapter, playing, current, onToggle }: Props) {
  const ready = chapter.status === "done";
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

  return (
    <li className={cx(styles.row, current && styles.current)}>
      <button
        type="button"
        className={cx(styles.play, playing && styles.playing)}
        disabled={!ready}
        aria-label={ready ? label : `Chapter ${chapter.position} is not ready to play`}
        aria-pressed={ready ? playing : undefined}
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
        {chapter.status === "failed" && chapter.error && (
          <p className={styles.errorText}>{chapter.error}</p>
        )}
      </div>

      <div className={styles.status}>
        <Status chapter={chapter} />
      </div>
    </li>
  );
}
