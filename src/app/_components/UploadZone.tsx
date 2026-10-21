"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, getConfig, uploadBook } from "../_lib/api";
import { cx } from "../_lib/cx";
import { UPLOAD_BUTTON_ID } from "../_lib/focus";
import { ProgressBar } from "./ProgressBar";
import styles from "./UploadZone.module.css";

type State =
  | { phase: "idle" }
  | { phase: "uploading"; name: string; progress: number }
  | { phase: "error"; message: string };

/** `limitMb` comes from the server; until it is known only the server checks the size. */
function checkFile(file: File, limitMb: number | null): string | null {
  if (!/\.epub$/i.test(file.name)) {
    return `"${file.name}" is not an EPUB. Only .epub files are supported for now (PDF is planned).`;
  }
  if (limitMb !== null && file.size > limitMb * 1024 * 1024) {
    return `"${file.name}" is larger than ${limitMb} MB, which is the upload limit.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  return null;
}

export function UploadZone() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const [limitMb, setLimitMb] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConfig().then(
      (config) => {
        if (!cancelled) setLimitMb(config.maxUploadMb);
      },
      () => {}, // The server still enforces the limit.
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const problem = checkFile(file, limitMb);
    if (problem) {
      setState({ phase: "error", message: problem });
      return;
    }
    setState({ phase: "uploading", name: file.name, progress: 0 });
    try {
      const book = await uploadBook(file, (progress) =>
        setState({ phase: "uploading", name: file.name, progress }),
      );
      router.push(`/books/${book.id}/preview`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "The upload failed.";
      setState({ phase: "error", message });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (state.phase !== "uploading") void upload(event.dataTransfer.files[0]);
  };

  const uploading = state.phase === "uploading";

  return (
    <section
      className={cx(styles.zone, dragging && styles.dragging)}
      aria-labelledby="upload-title"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h2 id="upload-title" className={styles.title}>
        {uploading ? "Uploading…" : "Add a book"}
      </h2>

      {uploading ? (
        <div className={styles.progress}>
          <p className={styles.fileName}>{state.name}</p>
          <ProgressBar value={state.progress} label={`Uploading ${state.name}`} />
          <p className={styles.hint}>
            {state.progress >= 1 ? "Reading the book…" : `${Math.round(state.progress * 100)}%`}
          </p>
        </div>
      ) : (
        <>
          <p className={styles.hint}>Drop an EPUB here, or choose one from your computer.</p>
          <button
            id={UPLOAD_BUTTON_ID}
            type="button"
            className={styles.choose}
            onClick={() => input.current?.click()}
          >
            Choose an EPUB
          </button>
        </>
      )}

      <input
        ref={input}
        type="file"
        accept=".epub,application/epub+zip"
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-label="EPUB file"
        onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <p className={styles.error} role="alert">
        {state.phase === "error" ? state.message : ""}
      </p>
    </section>
  );
}
