import Link from "next/link";
import type { ApiError } from "../_lib/api";
import shared from "./shared.module.css";

/** Loading and failure screens shared by the preview and the book page. */
export function LoadState({ error }: { error: ApiError | null }) {
  if (!error) {
    return (
      <div className={shared.page}>
        <p role="status" className={shared.lede}>
          Opening the book…
        </p>
      </div>
    );
  }
  const missing = error.status === 404 || error.status === 400;
  return (
    <div className={shared.page}>
      <div className={shared.notice} role="alert">
        <h1 className={shared.noticeTitle}>
          {missing ? "This book is not in the library" : "The book could not be loaded"}
        </h1>
        <p className={shared.noticeBody}>
          {missing ? "It may have been removed, or the link is wrong." : error.message}
        </p>
        <p className={shared.noticeBody}>
          <Link href="/">Back to the library</Link>
        </p>
      </div>
    </div>
  );
}
