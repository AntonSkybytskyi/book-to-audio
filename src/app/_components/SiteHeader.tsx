import Link from "next/link";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a className={styles.skip} href="#main">
          Skip to content
        </a>
        <Link href="/" className={styles.brand}>
          book-to-audio
        </Link>
        <nav aria-label="Main">
          <Link href="/settings" className={styles.link}>
            Settings
          </Link>
        </nav>
      </div>
    </header>
  );
}
