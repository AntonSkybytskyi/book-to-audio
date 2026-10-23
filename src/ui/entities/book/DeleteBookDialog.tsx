"use client";

import { deleteBook } from "./api";
import { useAction } from "@/ui/shared/lib/use-action";
import { ConfirmDialog } from "@/ui/shared/ui/ConfirmDialog";

interface Props {
  /** The book to delete, or null while the dialog is closed. */
  book: { id: string; title: string } | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

/** Asks before deleting a book, naming it, and says what is lost. Shared by the library and the book page. */
export function DeleteBookDialog({ book, onClose, onDeleted }: Props) {
  const action = useAction();
  const { clearError } = action;

  const close = () => {
    clearError();
    onClose();
  };
  const confirm = async () => {
    if (!book) return;
    if (await action.run(() => deleteBook(book.id))) onDeleted(book.id);
  };

  return (
    <ConfirmDialog
      open={book !== null}
      title={book ? `Delete “${book.title}”?` : "Delete book"}
      confirmLabel="Delete book"
      busyLabel="Deleting…"
      danger
      busy={action.busy}
      error={action.error}
      onConfirm={confirm}
      onCancel={close}
    >
      <p>
        The book, its cover and all of its audio will be removed from this computer. This cannot be
        undone.
      </p>
      <p>If the book is being converted, that stops now.</p>
    </ConfirmDialog>
  );
}
