"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, convertBook, setLanguage, type Language } from "../_lib/api";
import { formatMinutes, formatWords, languageName, pluralize } from "../_lib/format";
import { useBook } from "../_lib/use-book";
import { BookHeader } from "./BookHeader";
import { LoadState } from "./LoadState";
import styles from "./PreviewView.module.css";
import shared from "./shared.module.css";

const LANGUAGES: Language[] = ["en", "uk", "ru"];

export function PreviewView({ id }: { id: string }) {
  const router = useRouter();
  const { data: book, error, setData: setBook } = useBook(id);
  const [language, setLanguageChoice] = useState<Language | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A book that was already converted has no preview any more.
  // While converting from here, the click handler does the navigation.
  useEffect(() => {
    if (book && book.status !== "ready" && !busy) router.replace(`/books/${id}`);
  }, [book, busy, id, router]);

  if (!book || book.status !== "ready") return <LoadState error={error} />;

  const chosen = language ?? (book.language as Language);
  const hasVoice = book.availableLanguages.includes(chosen);
  const totalWords = book.wordCount;

  const convert = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (chosen !== book.language) setBook(await setLanguage(id, chosen));
      setBook(await convertBook(id));
      router.push(`/books/${id}`);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "Could not start the conversion.");
      setBusy(false);
    }
  };

  return (
    <div className={shared.page}>
      <BookHeader id={book.id} title={book.title} author={book.author} hasCover={book.hasCover} />

      <section className={styles.settings} aria-label="Conversion settings">
        <div className={styles.field}>
          <label htmlFor="language" className={styles.label}>
            Language of the book
          </label>
          <select
            id="language"
            className={styles.select}
            value={chosen}
            disabled={busy}
            aria-describedby="language-note"
            onChange={(event) => setLanguageChoice(event.target.value as Language)}
          >
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
                {book.availableLanguages.includes(code) ? "" : " (no voice yet)"}
              </option>
            ))}
          </select>
        </div>
        <p id="language-note" className={hasVoice ? styles.note : styles.warning}>
          {hasVoice
            ? "The book is read in the default voice for this language."
            : `There is no ${languageName(chosen)} voice installed yet, so this book cannot be converted in ${languageName(chosen)}. Pick ${book.availableLanguages.map(languageName).join(" or ")}.`}
        </p>
      </section>

      <section aria-labelledby="chapters-title" className={styles.chapters}>
        <div className={styles.chaptersHead}>
          <h2 id="chapters-title" className={styles.chaptersTitle}>
            {pluralize(book.chapterCount, "chapter")}
          </h2>
          <p className={styles.total}>
            {formatWords(totalWords)} · about {formatMinutes(book.estimatedMinutes)} of audio
          </p>
        </div>
        <ol className={styles.list}>
          {book.chapters.map((chapter) => (
            <li key={chapter.position} className={styles.row}>
              <span className={styles.number} aria-hidden="true">
                {chapter.position}
              </span>
              <span className={styles.chapterTitle}>{chapter.title}</span>
              <span className={styles.length}>
                {formatWords(chapter.wordCount)} · {formatMinutes(chapter.estimatedMinutes)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className={styles.actions}>
        <button
          type="button"
          className={shared.button}
          disabled={busy || !hasVoice}
          onClick={convert}
        >
          {busy ? "Starting…" : "Convert"}
        </button>
        <p className={shared.error} role="alert">
          {failure}
        </p>
      </div>
    </div>
  );
}
