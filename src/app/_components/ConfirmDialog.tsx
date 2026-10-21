"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../_lib/cx";
import styles from "./ConfirmDialog.module.css";
import shared from "./shared.module.css";

interface Props {
  open: boolean;
  title: string;
  /** What the confirm button says, for example "Delete book". */
  confirmLabel: string;
  /** What it says while the request runs, for example "Deleting…". */
  busyLabel: string;
  /** Destructive actions get a red button. */
  danger?: boolean;
  busy: boolean;
  /** The message of a failed request, shown inside the dialog. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

/**
 * A modal confirmation on the native `<dialog>`: the browser traps focus inside it and
 * closes it on Escape. Focus starts on Cancel, and goes back to the button that opened it.
 * While the request runs it cannot be dismissed.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busyLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
      cancel.current?.focus();
    } else if (!open && element.open) {
      element.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) {
        opener.current.focus();
      }
      opener.current = null;
    }
  }, [open]);

  // A dialog that is still open when its component goes away would leave the page inert.
  useEffect(() => () => dialog.current?.close(), []);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault(); // Escape: let React's state close it, not the browser.
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className={styles.content}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
        <p className={shared.error} role="alert">
          {error}
        </p>
        <div className={styles.actions}>
          <button
            ref={cancel}
            type="button"
            className={cx(shared.button, shared.quiet)}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={cx(shared.button, danger && shared.danger)}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
