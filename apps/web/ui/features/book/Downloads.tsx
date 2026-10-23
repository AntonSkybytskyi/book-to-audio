"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { downloadUrl, rebuildOutputs, type Book, type DownloadKind } from "@/ui/entities/book/api";
import { cx } from "@/ui/shared/lib/cx";
import { downloadsState } from "./downloads-state";
import { formatLeft, secondsLeft, type ProgressSample } from "./eta";
import { formatBytes } from "@/ui/shared/lib/format";
import { useGuardedMutation } from "@/ui/shared/api/use-guarded-mutation";
import { Button } from "@/ui/shared/ui/Button";
import { ProgressBar } from "@/ui/shared/ui/ProgressBar";

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
  // 5xx: core is down or failing (nginx answers 502 while it restarts), not a change of the files.
  if (res.status >= 500) return "unreachable";
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
  const retry = useGuardedMutation();
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
        "mb-6 grid gap-[0.85rem] border border-rule bg-paper-raised px-[1.1rem] pt-4 pb-[1.1rem]",
        // The same red edge a failed chapter row has.
        (state.kind === "failed" || (state.kind === "ready" && state.rebuild?.kind === "failed")) &&
          "border-l-[0.25rem] border-l-danger",
      )}
      aria-labelledby="downloads-title"
      aria-busy={building}
    >
      <h2 id="downloads-title" className="font-serif text-[1.15rem] leading-[1.3] font-semibold">
        Downloads
      </h2>

      <ul className="flex flex-wrap gap-x-6 gap-y-[0.85rem] max-sm:grid">
        {FILES.map(({ kind, label: name, about }) => (
          <li
            key={kind}
            className="grid min-w-0 justify-items-start gap-[0.3rem] max-sm:justify-items-stretch"
          >
            {sizes ? (
              // Not prefetched: the link is a file download, not a page.
              <Button
                href={downloadUrl(book.id, kind)}
                prefetch={false}
                download
                onClick={(event: MouseEvent<HTMLAnchorElement>) => void download(event, kind)}
                size="small"
                variant={kind === "zip" ? "outline" : "primary"}
              >
                <span>{name}</span>
                <span className="font-normal tabular-nums opacity-85">
                  {formatBytes(sizes[kind])}
                </span>
              </Button>
            ) : (
              <Button disabled size="small" variant="unavailable">
                {name}
              </Button>
            )}
            <span className="text-[0.8rem] text-ink-muted">{about}</span>
          </li>
        ))}
      </ul>

      {building && (
        <div className="grid gap-2">
          <p
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span>{label}</span>
            {!starting && progress !== null && (
              <span className="font-semibold text-accent tabular-nums" aria-hidden="true">
                {percent(progress)}
              </span>
            )}
            {timeLeft && <span className="text-[0.9rem] text-ink-muted">{timeLeft}</span>}
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
        <p className="text-[0.95rem] text-ink-muted" role="status">
          {state.message}
        </p>
      )}

      {(state.kind === "failed" ||
        (state.kind === "ready" && state.rebuild?.kind === "failed")) && (
        <div className="grid gap-2">
          <p className="text-danger" role="alert">
            {state.kind === "failed"
              ? state.error
              : `The last rebuild failed, these files are still good. ${state.rebuild?.kind === "failed" ? state.rebuild.error : ""}`}
          </p>
          <div>
            <Button size="small" disabled={retry.busy} onClick={rebuild}>
              {retry.busy ? "Starting…" : "Retry"}
            </Button>
          </div>
        </div>
      )}

      {(retry.error || notice) && (
        <p className="text-danger" role="alert">
          {retry.error ?? notice}
        </p>
      )}
    </section>
  );
}
