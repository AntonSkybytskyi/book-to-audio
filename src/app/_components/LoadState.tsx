import Link from "next/link";
import type { ApiError } from "../_lib/api";
import { Notice } from "./Notice";
import { Page } from "./Page";

/** Loading and failure screens shared by the preview and the book page. */
export function LoadState({ error }: { error: ApiError | null }) {
  if (!error) {
    return (
      <Page>
        <p role="status" className="mt-2 max-w-[34rem] text-ink-muted">
          Opening the book…
        </p>
      </Page>
    );
  }
  const missing = error.status === 404 || error.status === 400;
  return (
    <Page>
      <Notice
        title={missing ? "This book is not in the library" : "The book could not be loaded"}
        level={1}
        role="alert"
      >
        <p>{missing ? "It may have been removed, or the link is wrong." : error.message}</p>
        <p>
          <Link href="/">Back to the library</Link>
        </p>
      </Notice>
    </Page>
  );
}
