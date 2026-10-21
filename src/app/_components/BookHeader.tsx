import type { ReactNode } from "react";
import { languageName } from "../_lib/format";
import { BookCover } from "./BookCover";
import styles from "./BookHeader.module.css";

interface Props {
  id: string;
  title: string;
  author: string | null;
  hasCover: boolean;
  language?: string;
  children?: ReactNode;
}

/** Cover, title and author shared by the preview and the book page. */
export function BookHeader({ id, title, author, hasCover, language, children }: Props) {
  return (
    <header className={styles.header}>
      <BookCover id={id} title={title} hasCover={hasCover} size="large" />
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.author}>{author ?? "Unknown author"}</p>
        {language && <p className={styles.language}>{languageName(language)}</p>}
        {children}
      </div>
    </header>
  );
}
