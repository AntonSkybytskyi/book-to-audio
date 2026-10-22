import type { Book } from "./api";
import { pluralize } from "./format";

/** What the Downloads section of the book page shows. */
export type DownloadsState =
  | { kind: "hidden" }
  /** The book is not done: nothing to download yet, and nothing was built before. */
  | { kind: "waiting"; message: string }
  /** The files built earlier no longer match the chapters; new ones are on their way. */
  | { kind: "updating"; message: string; progress: number | null }
  | { kind: "preparing"; message: string; progress: number | null }
  | { kind: "failed"; error: string }
  /** The files are current. `rebuild` says what a rebuild of the same audio, running or failed, is doing next to them. */
  | {
      kind: "ready";
      m4bBytes: number;
      zipBytes: number;
      rebuild:
        | { kind: "building"; progress: number | null }
        | { kind: "failed"; error: string }
        | null;
    };

/**
 * Which of the five states the downloads are in. The server's `available` already means "built
 * from the current audio and the book is done", but the page also checks the book's own status,
 * which it hears about first, so a button never offers a file that is about to be stale.
 */
export function downloadsState(book: Book): DownloadsState {
  const { outputs } = book;
  if (book.status === "ready") return { kind: "hidden" };
  if (book.status !== "done") {
    if (outputs.updating) {
      return {
        kind: "updating",
        message: "Updating downloads… They are rebuilt when every chapter is done again.",
        progress: null,
      };
    }
    const failed =
      book.status === "done_with_errors"
        ? ` ${pluralize(book.failedCount, "failed chapter")} to regenerate first.`
        : "";
    return {
      kind: "waiting",
      message: `Downloads are ready when every chapter is done.${failed}`,
    };
  }
  if (outputs.available && outputs.m4bBytes !== null && outputs.zipBytes !== null) {
    return {
      kind: "ready",
      m4bBytes: outputs.m4bBytes,
      zipBytes: outputs.zipBytes,
      rebuild: readyRebuild(outputs),
    };
  }
  if (outputs.state === "failed") {
    return { kind: "failed", error: outputs.error ?? "The downloads could not be built." };
  }
  const progress = outputs.state === "building" ? outputs.progress : null;
  return outputs.updating
    ? { kind: "updating", message: "Updating downloads…", progress }
    : { kind: "preparing", message: "Preparing downloads…", progress };
}

/** A rebuild of the audio that is already on offer (forced, or a retry): the files stay, and this is what happens beside them. */
function readyRebuild(
  outputs: Book["outputs"],
): Extract<DownloadsState, { kind: "ready" }>["rebuild"] {
  if (outputs.state === "building") return { kind: "building", progress: outputs.progress };
  if (outputs.state === "queued") return { kind: "building", progress: null };
  if (outputs.state === "failed") {
    return { kind: "failed", error: outputs.error ?? "The downloads could not be rebuilt." };
  }
  return null;
}
