import Link from "next/link";
import { Notice } from "./Notice";
import { Page } from "./Page";

/** Shown on a book's page after the book was deleted, here or from another tab. */
export function BookDeleted() {
  return (
    <Page>
      <Notice title="This book was deleted" level={1} role="alert">
        <p>Its audio and files have been removed.</p>
        <p>
          <Link href="/">Back to the library</Link>
        </p>
      </Notice>
    </Page>
  );
}
