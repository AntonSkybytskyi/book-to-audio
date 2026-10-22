"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ApiError,
  convertBook,
  getLanguageEstimate,
  getSettings,
  setLanguage,
  type Language,
  type LanguageEstimate,
} from "../_lib/api";
import { formatWords, languageName, pluralize } from "../_lib/format";
import {
  ALL_LANGUAGES,
  languageNote,
  needsLanguageChoice,
  pickerOptions,
} from "../_lib/language-picker";
import { chapterLength, previewText } from "../_lib/time-left";
import { useBenchmark } from "../_lib/use-benchmark";
import { useBook } from "../_lib/use-book";
import { BookHeader } from "./BookHeader";
import { BookDeleted } from "./BookDeleted";
import { LoadState } from "./LoadState";
import styles from "./PreviewView.module.css";
import shared from "./shared.module.css";

export function PreviewView({ id }: { id: string }) {
  const router = useRouter();
  const { data: book, error, deleted, setData: setBook } = useBook(id);
  const { data: speedTest } = useBenchmark();
  const [language, setLanguageChoice] = useState<Language | null>(null);
  // The languages the settings show in the picker; if they cannot be read, the picker offers all.
  const [shown, setShown] = useState<Language[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The length and conversion time in a language other than the one the book came with.
  const [other, setOther] = useState<{
    language: Language;
    estimate: LanguageEstimate | null;
  } | null>(null);
  const chosenLanguage = language ?? (book?.language as Language | undefined);
  const hasOwnLanguage = book !== null && chosenLanguage === book.language;
  const voiceOk = book?.availableLanguages.includes(chosenLanguage ?? "") ?? false;

  useEffect(() => {
    if (!chosenLanguage || hasOwnLanguage || !voiceOk) return;
    let cancelled = false;
    getLanguageEstimate(id, chosenLanguage).then(
      (estimate) => !cancelled && setOther({ language: chosenLanguage, estimate }),
      // Without an estimate the preview still works; the line just stays out.
      () => !cancelled && setOther({ language: chosenLanguage, estimate: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [id, chosenLanguage, hasOwnLanguage, voiceOk]);

  // A book that was already converted has no preview any more.
  // While converting from here, the click handler does the navigation.
  useEffect(() => {
    if (book && book.status !== "ready" && !busy) router.replace(`/books/${id}`);
  }, [book, busy, id, router]);

  useEffect(() => {
    getSettings().then(
      ({ data }) => setShown(data.shownLanguages),
      () => setShown(ALL_LANGUAGES),
    );
  }, []);

  if (deleted) return <BookDeleted />;
  if (!book || book.status !== "ready" || !shown) return <LoadState error={error} />;

  // A book whose language nobody could tell is not converted in English by one click.
  const needsChoice = needsLanguageChoice(book.languageSource, language !== null);
  const chosen = language ?? (book.language as Language);
  const hasVoice = book.availableLanguages.includes(chosen);
  const totalWords = book.wordCount;
  // For the book's own language it is in the book; for another one it was asked for.
  const onShow = hasOwnLanguage
    ? { estimate: book.estimate, chapterSeconds: book.chapters.map((c) => c.estimatedSeconds) }
    : other?.language === chosen
      ? other.estimate
      : null;
  const estimateText =
    hasVoice && !needsChoice && onShow?.estimate ? previewText(onShow.estimate) : null;
  const estimating = hasVoice && !needsChoice && !hasOwnLanguage && other?.language !== chosen;
  // The text of the book is still being counted (just uploaded, or the language was changed).
  const measuring = hasVoice && !needsChoice && hasOwnLanguage && book.measuring;
  const testing = speedTest !== null && speedTest.state !== "idle";
  const options = pickerOptions(shown, book.language as Language, book.availableLanguages);
  const note = languageNote(
    book.languageSource,
    book.language as Language,
    book.declaredLanguage,
    // Once the owner picked, a note about where the pre-selection came from no longer applies.
    chosen !== book.language || (language !== null && book.languageSource === "unknown"),
  );

  const convert = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (chosen !== book.language || book.languageSource === "unknown") {
        setBook(await setLanguage(id, chosen));
      }
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
            value={needsChoice ? "" : chosen}
            disabled={busy}
            aria-describedby="language-note"
            onChange={(event) => setLanguageChoice(event.target.value as Language)}
          >
            {needsChoice && (
              <option value="" disabled>
                Choose a language…
              </option>
            )}
            {options.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <p
          id="language-note"
          className={
            hasVoice ? (note.tone === "check" ? styles.check : styles.note) : styles.warning
          }
        >
          {hasVoice ? (
            <>
              {note.headline && <strong className={styles.origin}>{note.headline}. </strong>}
              {note.text}
            </>
          ) : (
            `There is no ${languageName(chosen)} voice installed yet, so this book cannot be converted in ${languageName(chosen)}. Pick ${book.availableLanguages.map(languageName).join(" or ")}.`
          )}
        </p>
      </section>

      <section aria-labelledby="chapters-title" className={styles.chapters}>
        <div className={styles.chaptersHead}>
          <h2 id="chapters-title" className={styles.chaptersTitle}>
            {pluralize(book.chapterCount, "chapter")}
          </h2>
          <p className={styles.total}>
            {formatWords(totalWords)}
            {estimateText && ` · ${estimateText.audio}`}
          </p>
        </div>
        <div className={styles.estimate} role="status" aria-live="polite">
          {(estimating || measuring) && <p>Working out how long it will take…</p>}
          {estimateText && (
            <>
              <p>
                {estimateText.convert.charAt(0).toUpperCase() + estimateText.convert.slice(1)}.
                {estimateText.rough &&
                  (testing ? (
                    " Measuring speed… this rough estimate gets better when the speed test is done."
                  ) : (
                    <>
                      {" "}
                      This is a rough estimate: <Link href="/settings">run a speed test</Link> for a
                      better one.
                    </>
                  ))}
              </p>
              {estimateText.queue && <p>{estimateText.queue}</p>}
            </>
          )}
        </div>
        <ol className={styles.list}>
          {book.chapters.map((chapter, index) => (
            <li key={chapter.position} className={styles.row}>
              <span className={styles.number} aria-hidden="true">
                {chapter.position}
              </span>
              <span className={styles.chapterTitle}>{chapter.title}</span>
              <span className={styles.length}>
                {[
                  formatWords(chapter.wordCount),
                  hasVoice ? chapterLength(shownChapterSeconds(onShow, index)) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className={styles.actions}>
        <button
          type="button"
          className={shared.button}
          disabled={busy || !hasVoice || needsChoice}
          aria-describedby={needsChoice ? "language-required" : undefined}
          onClick={convert}
        >
          {busy ? "Starting…" : "Convert"}
        </button>
        {needsChoice && (
          <p id="language-required" className={styles.note}>
            Choose the language of the book first.
          </p>
        )}
        <p className={shared.error} role="alert">
          {failure}
        </p>
      </div>
    </div>
  );
}

/** The expected audio length of one chapter from whichever estimate is on show. */
function shownChapterSeconds(
  shown: LanguageEstimate | { chapterSeconds: (number | null)[] } | null,
  index: number,
): number | null {
  return shown?.chapterSeconds[index] ?? null;
}
