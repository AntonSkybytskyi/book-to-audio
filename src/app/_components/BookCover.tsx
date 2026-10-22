import { coverUrl } from "../_lib/api";
import { cx } from "../_lib/cx";
import styles from "./BookCover.module.css";

interface Props {
  id: string;
  title: string;
  hasCover: boolean;
  size: "small" | "large";
}

/** The cover image, or a plain typographic stand-in when the book has none. */
export function BookCover({ id, title, hasCover, size }: Props) {
  return (
    <div className={cx(styles.cover, size === "large" ? styles.large : styles.small)}>
      {hasCover ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by our API, sized by CSS
        <img src={coverUrl(id)} alt="" className={styles.image} loading="lazy" />
      ) : (
        <span className={styles.placeholder} aria-hidden="true">
          {title.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </div>
  );
}
