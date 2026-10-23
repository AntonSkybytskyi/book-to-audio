"use client";

import type { Chapter } from "@/ui/entities/book/api";
import {
  canPlay,
  canRegenerate,
  isFinishing,
  isRegenerating,
  regenerateLabel,
} from "@/ui/entities/book/chapter";
import { cx } from "@/ui/shared/lib/cx";
import { formatClock } from "@/ui/shared/lib/format";
import { useGuardedMutation } from "@/ui/shared/api/use-guarded-mutation";
import { Button } from "@/ui/shared/ui/Button";
import { ProgressBar } from "@/ui/shared/ui/ProgressBar";

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

const ROW =
  "grid grid-cols-[2.75rem_1fr_auto] items-center gap-3 border-b border-rule px-2 py-3 transition-[background-color] duration-200 ease-[ease] max-sm:grid-cols-[2.75rem_1fr]";
const TITLE = "font-serif text-[1.05rem] leading-[1.35] wrap-anywhere";
const MUTED = "text-ink-muted";
const WORKING = "font-semibold text-accent";
const ERROR_TEXT = "text-[0.85rem] text-danger wrap-anywhere";

function Status({ chapter, bookPaused }: { chapter: Chapter; bookPaused: boolean }) {
  const again = isRegenerating(chapter);
  switch (chapter.status) {
    case "pending":
      return null; // The book has not been converted, so there is nothing to report.
    case "queued":
      if (again) {
        return (
          <span className={WORKING}>
            {bookPaused ? "Regenerating · on hold" : "Regenerating · waiting"}
          </span>
        );
      }
      return <span className={MUTED}>{bookPaused ? "On hold" : "Waiting"}</span>;
    case "generating":
      // Every chunk is read; what is left is joining them into the chapter's file.
      if (isFinishing(chapter)) return <span className={WORKING}>Finishing…</span>;
      return (
        <span className={WORKING}>
          {again ? "Regenerating" : "Reading aloud"} {Math.round(chapter.progress * 100)}%
        </span>
      );
    case "done":
      return <span className={MUTED}>{formatClock(chapter.durationSeconds ?? 0)}</span>;
    case "failed":
      return <span className="font-semibold text-danger">Failed</span>;
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
  const regenerate = useGuardedMutation();
  const playable = canPlay(chapter);
  const label = `${playing ? "Pause" : "Play"} chapter ${chapter.position}, ${chapter.title}`;

  if (chapter.status === "pending") {
    return (
      <li className={ROW}>
        <span
          className="grid w-11 place-items-center text-ink-muted tabular-nums"
          aria-hidden="true"
        >
          {chapter.position}
        </span>
        <p className={TITLE}>{chapter.title}</p>
      </li>
    );
  }

  const failed = chapter.status === "failed";
  const click = () =>
    chapter.status === "generating"
      ? onConfirmRegenerate(chapter.position)
      : void regenerate.run(() => onRegenerate(chapter.position));

  return (
    <li
      className={cx(
        ROW,
        failed ? "border-l-[0.25rem] border-l-danger bg-paper-raised" : current && "bg-accent-soft",
      )}
    >
      <button
        type="button"
        className={cx(
          "grid size-11 cursor-pointer place-items-center rounded-full border border-accent transition-[background-color,color,opacity] duration-150 ease-[ease] enabled-hover:bg-accent enabled-hover:text-accent-ink disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-muted disabled:opacity-60",
          playing ? "bg-accent text-accent-ink" : "bg-transparent text-accent",
        )}
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

      <div className="grid min-w-0 gap-[0.35rem]">
        <p className={TITLE}>
          <span className="text-ink-muted tabular-nums">{chapter.position}.</span> {chapter.title}
        </p>
        {chapter.status === "generating" && (
          <ProgressBar
            thin
            busy={isFinishing(chapter)}
            value={chapter.progress}
            label={`Chapter ${chapter.position} progress`}
          />
        )}
        {failed && chapter.error && <p className={ERROR_TEXT}>{chapter.error}</p>}
        {chapter.status === "done" && chapter.regenError && (
          <p className={ERROR_TEXT} role="status">
            Regeneration failed: {chapter.regenError} The previous audio was kept.
          </p>
        )}
        {failed && chapter.hasAudio && (
          <p className="text-[0.85rem] text-ink-muted">
            The previous audio of this chapter can still be played.
          </p>
        )}
        {canRegenerate(chapter) && (
          <div className="mt-[0.15rem] flex">
            {/* A failed chapter's button is the filled one: it is what the row is waiting for. */}
            <Button
              size={failed ? "smallTall" : "small"}
              variant={failed ? "primary" : "muted"}
              aria-label={regenerateLabel(chapter)}
              disabled={regenerate.busy}
              onClick={click}
            >
              {regenerate.busy ? "Starting…" : "Regenerate"}
            </Button>
          </div>
        )}
        {regenerate.error && (
          <p className="text-danger" role="alert">
            {regenerate.error}
          </p>
        )}
      </div>

      <div className="text-right text-[0.85rem] whitespace-nowrap tabular-nums max-sm:col-[2] max-sm:-mt-2 max-sm:text-left">
        <Status chapter={chapter} bookPaused={bookPaused} />
      </div>
    </li>
  );
}
