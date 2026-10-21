import Link from "next/link";
import shared from "./shared.module.css";

/** Shown on a book's page after the book was deleted, here or from another tab. */
export function BookDeleted() {
  return (
    <div className={shared.page}>
      <div className={shared.notice} role="alert">
        <h1 className={shared.noticeTitle}>This book was deleted</h1>
        <p className={shared.noticeBody}>Its audio and files have been removed.</p>
        <p className={shared.noticeBody}>
          <Link href="/">Back to the library</Link>
        </p>
      </div>
    </div>
  );
}
