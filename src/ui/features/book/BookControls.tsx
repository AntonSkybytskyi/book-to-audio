"use client";

import { useState } from "react";
import { pauseBook, regenerateBook, resumeBook, type Book } from "@/ui/entities/book/api";
import { pluralize } from "@/ui/shared/lib/format";
import { useGuardedMutation } from "@/ui/shared/api/use-guarded-mutation";
import { Button } from "@/ui/shared/ui/Button";
import { ConfirmDialog } from "@/ui/shared/ui/ConfirmDialog";

interface Props {
  book: Book;
  /** Loads the book again after a request changed it. */
  onChanged: () => void;
  onDelete: () => void;
}

/** Pause or resume, regenerate and delete for a book that has been queued. */
export function BookControls({ book, onChanged, onDelete }: Props) {
  const toggle = useGuardedMutation();
  const regenerate = useGuardedMutation();
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
    <section className="mb-6 grid gap-[0.4rem]" aria-label="Book controls">
      <div className="flex flex-wrap gap-[0.6rem]">
        {canToggle && (
          <Button size="small" disabled={toggle.busy} onClick={flip}>
            {paused ? "Resume this book" : "Pause this book"}
          </Button>
        )}
        <Button size="small" variant="outline" onClick={() => setConfirming(true)}>
          Regenerate book
        </Button>
        {/* Kept apart from the safe actions, at the far end. */}
        <Button
          size="small"
          variant="outlineDanger"
          className="ml-auto max-sm:ml-0"
          onClick={onDelete}
        >
          Delete book
        </Button>
      </div>
      <p className="text-[0.9rem] text-danger" role="alert">
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
