"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";

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
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-base border border-rule bg-paper-raised p-0 text-ink shadow-[0_1.5rem_3rem_rgb(0_0_0/0.25)] backdrop:bg-[rgb(20_15_10/0.55)]"
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
      <div className="grid gap-[0.9rem] p-6">
        <h2
          id={titleId}
          className="font-serif text-[1.35rem] leading-[1.25] font-semibold wrap-anywhere"
        >
          {title}
        </h2>
        <div id={bodyId} className="grid gap-[0.6rem] text-[0.95rem] text-ink-muted wrap-anywhere">
          {children}
        </div>
        <p className="text-danger" role="alert">
          {error}
        </p>
        <div className="flex flex-wrap justify-end gap-3 max-sm:*:flex-[1_1_100%]">
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
