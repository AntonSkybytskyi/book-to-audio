"use client";

import { useState } from "react";
import { pauseBook, regenerateBook, resumeBook, type Book } from "../_lib/api";
import { cx } from "../_lib/cx";
import { pluralize } from "../_lib/format";
import { useAction } from "../_lib/use-action";
import styles from "./BookControls.module.css";
import { ConfirmDialog } from "./ConfirmDialog";
import shared from "./shared.module.css";

interface Props {
  book: Book;
  /** Loads the book again after a request changed it. */
  onChanged: () => void;
  onDelete: () => void;
}

/** Pause or resume, regenerate and delete for a book that has been queued. */
export function BookControls({ book, onChanged, onDelete }: Props) {
  const toggle = useAction();
  const regenerate = useAction();
  const [confirming, setConfirming] = useState(false);

  if (book.status === "ready") return null;

  const paused = book.status === "paused";
  const canToggle = book.status === "converting" || paused;
  const total = pluralize(book.chapterCount, "chapter");

  const flip = async () => {
    if (await toggle.run(() => (paused ? resumeBook(book.id) : pauseBook(book.id)))) onChanged();
  };
  const confirmRegenerate = async () => {
    if (await regenerate.run(() => regenerateBook(book.id))) {
      setConfirming(false);
      onChanged();
    }
  };

  return (
    <section className={styles.controls} aria-label="Book controls">
      <div className={styles.buttons}>
        {canToggle && (
          <button
            type="button"
            className={cx(shared.button, shared.small)}
            disabled={toggle.busy}
            onClick={flip}
          >
            {paused ? "Resume this book" : "Pause this book"}
          </button>
        )}
        <button
          type="button"
          className={cx(shared.button, shared.small, shared.outline)}
          onClick={() => setConfirming(true)}
        >
          Regenerate book
        </button>
        <button
          type="button"
          className={cx(shared.button, shared.small, shared.outlineDanger, styles.delete)}
          onClick={onDelete}
        >
          Delete book
        </button>
      </div>
      <p className={cx(shared.error, styles.error)} role="alert">
        {toggle.error}
      </p>

      <ConfirmDialog
        open={confirming}
        title="Regenerate the whole book?"
        confirmLabel="Regenerate book"
        busyLabel="Starting…"
        busy={regenerate.busy}
        error={regenerate.error}
        onConfirm={confirmRegenerate}
        onCancel={() => {
          regenerate.clearError();
          setConfirming(false);
        }}
      >
        <p>All {total} are read aloud again from the start, which can take a long while.</p>
        <p>
          Chapters that are ready stay playable until their new audio replaces them. A chapter that
          is being read right now loses its progress.
        </p>
      </ConfirmDialog>
    </section>
  );
}
