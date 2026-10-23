"use client";

import type { Chapter } from "@/ui/entities/book/api";
import { useAction } from "@/ui/shared/lib/use-action";
import { ConfirmDialog } from "@/ui/shared/ui/ConfirmDialog";

interface Props {
  /** The chapter being asked about, or null while the dialog is closed. */
  chapter: Chapter | null;
  onRegenerate: (position: number) => Promise<unknown>;
  onClose: () => void;
}

/** One dialog for the whole chapter list: starting a running chapter again throws its progress away. */
export function RegenerateChapterDialog({ chapter, onRegenerate, onClose }: Props) {
  const action = useAction();
  const { clearError } = action;

  const close = () => {
    clearError();
    onClose();
  };
  const confirm = async () => {
    if (chapter && (await action.run(() => onRegenerate(chapter.position)))) onClose();
  };
  const running = chapter?.status === "generating";

  return (
    <ConfirmDialog
      open={chapter !== null}
      title={chapter ? `Regenerate chapter ${chapter.position}?` : "Regenerate chapter"}
      confirmLabel="Regenerate chapter"
      busyLabel="Starting…"
      busy={action.busy}
      error={action.error}
      onConfirm={confirm}
      onCancel={close}
    >
      {chapter && (
        <p>
          {running
            ? `“${chapter.title}” is being read aloud right now. Starting again throws away the ${Math.round(chapter.progress * 100)}% that is done.`
            : `“${chapter.title}” will be read aloud again from the start.`}
        </p>
      )}
    </ConfirmDialog>
  );
}
