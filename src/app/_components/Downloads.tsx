"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { downloadUrl, rebuildOutputs, type Book, type DownloadKind } from "../_lib/api";
import { cx } from "../_lib/cx";
import { downloadsState } from "../_lib/downloads";
import { formatLeft, secondsLeft, type ProgressSample } from "../_lib/eta";
import { formatBytes } from "../_lib/format";
import { useAction } from "../_lib/use-action";
import styles from "./Downloads.module.css";
import { ProgressBar } from "./ProgressBar";
import shared from "./shared.module.css";

interface Props {
  book: Book;
  /** Loads the book again after a request changed it. */
  onChanged: () => void;
}

const FILES: { kind: DownloadKind; label: string; about: string }[] = [
  { kind: "m4b", label: "Audiobook (M4B)", about: "One file with chapters, cover and tags" },
  { kind: "zip", label: "Chapters (WebM ZIP)", about: "One tagged WebM file per chapter" },
];

/** What is left of a build, from the progress the page has seen since it started (null while there is too little to go on). */
function useTimeLeft(progress: number | null): string | null {
  const first = useRef<ProgressSample | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const now = progress === null ? null : { at: Date.now(), progress };
    // A build that starts over (progress went back) is timed from its new start.
    if (now === null || first.current === null || now.progress < first.current.progress) {
      first.current = now;
    }
    const next = now !== null && first.current !== null ? secondsLeft(first.current, now) : null;
    // After the effect has run, not inside it: this is a reading of the clock, not a reaction to state.
    queueMicrotask(() => setLeft(next));
  }, [progress]);
  return left === null ? null : formatLeft(left);
}

const percent = (fraction: number) => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

/** Starts the download from a link, unless the server says the files are not current any more. */
async function startDownload(url: string): Promise<"started" | "changed" | "unreachable"> {
  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD" });
  } catch {
    return "unreachable";
  }
  if (!res.ok) return "changed";
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  return "started";
}

/** The M4B and ZIP of a finished book: what state they are in, and the links once they are current. */
export function Downloads({ book, onChanged }: Props) {
  const retry = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const state = downloadsState(book);
  const building =
    state.kind === "preparing" ||
    state.kind === "updating" ||
    (state.kind === "ready" && state.rebuild?.kind === "building");
  const progress =
    state.kind === "ready"
      ? state.rebuild?.kind === "building"
        ? state.rebuild.progress
        : null
      : state.kind === "preparing" || state.kind === "updating"
        ? state.progress
        : null;
  const timeLeft = useTimeLeft(building ? progress : null);
  if (state.kind === "hidden") return null;

  const sizes = state.kind === "ready" ? { m4b: state.m4bBytes, zip: state.zipBytes } : null;

  const rebuild = async () => {
    if (await retry.run(() => rebuildOutputs(book.id))) onChanged();
  };

  // A plain click checks first, so a file that went stale a moment ago says so instead of
  // opening an error page. Other clicks (new tab, save as) use the link as it is.
  const download = async (event: MouseEvent<HTMLAnchorElement>, kind: DownloadKind) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    setNotice(null);
    const outcome = await startDownload(downloadUrl(book.id, kind));
    if (outcome === "changed") {
      setNotice("The downloads changed a moment ago. Loading the new state…");
      onChanged();
    } else if (outcome === "unreachable") {
      setNotice("Could not reach the server. Check that the app is still running.");
    }
  };

  const starting = building && (progress === null || progress < 0.01);
  const label =
    state.kind === "preparing" || state.kind === "updating"
      ? state.message
      : "Rebuilding the downloads…";

  return (
    <section
      className={cx(
        styles.downloads,
        (state.kind === "failed" || (state.kind === "ready" && state.rebuild?.kind === "failed")) &&
          styles.failed,
      )}
      aria-labelledby="downloads-title"
      aria-busy={building}
    >
      <h2 id="downloads-title" className={styles.heading}>
        Downloads
      </h2>

      <ul className={styles.files}>
        {FILES.map(({ kind, label: name, about }) => (
          <li key={kind} className={styles.file}>
            {sizes ? (
              <a
                href={downloadUrl(book.id, kind)}
                download
                onClick={(event) => void download(event, kind)}
                className={cx(shared.button, shared.small, kind === "zip" && shared.outline)}
              >
                <span>{name}</span>
                <span className={styles.size}>{formatBytes(sizes[kind])}</span>
              </a>
            ) : (
              <button
                type="button"
                disabled
                className={cx(shared.button, shared.small, styles.unavailable)}
              >
                {name}
              </button>
            )}
            <span className={styles.about}>{about}</span>
          </li>
        ))}
      </ul>

      {building && (
        <div className={styles.status}>
          <p role="status" aria-live="polite" className={styles.line}>
            <span>{label}</span>
            {!starting && progress !== null && (
              <span className={styles.percent} aria-hidden="true">
                {percent(progress)}
              </span>
            )}
            {timeLeft && <span className={styles.left}>{timeLeft}</span>}
          </p>
          <ProgressBar
            thin
            value={starting ? 1 : (progress ?? 1)}
            busy={starting}
            label="Preparing the downloads"
          />
        </div>
      )}

      {state.kind === "waiting" && (
        <p className={styles.muted} role="status">
          {state.message}
        </p>
      )}

      {(state.kind === "failed" ||
        (state.kind === "ready" && state.rebuild?.kind === "failed")) && (
        <div className={styles.status}>
          <p className={shared.error} role="alert">
            {state.kind === "failed"
              ? state.error
              : `The last rebuild failed, these files are still good. ${state.rebuild?.kind === "failed" ? state.rebuild.error : ""}`}
          </p>
          <div>
            <button
              type="button"
              className={cx(shared.button, shared.small)}
              disabled={retry.busy}
              onClick={rebuild}
            >
              {retry.busy ? "Starting…" : "Retry"}
            </button>
          </div>
        </div>
      )}

      {(retry.error || notice) && (
        <p className={shared.error} role="alert">
          {retry.error ?? notice}
        </p>
      )}
    </section>
  );
}
