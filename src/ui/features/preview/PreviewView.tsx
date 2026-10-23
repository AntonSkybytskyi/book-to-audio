"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/ui/shared/api/request";
import { convertBook, setLanguage } from "@/ui/entities/book/api";
import { getLanguageEstimate, type LanguageEstimate } from "./api";
import { getSettings } from "@/ui/entities/settings/api";
import { type Language } from "@/ui/entities/language/api";
import { formatWords, pluralize } from "@/ui/shared/lib/format";
import { languageName } from "@/ui/entities/language/language-names";
import {
  ALL_LANGUAGES,
  languageNote,
  needsLanguageChoice,
  pickerOptions,
} from "@/ui/entities/language/language-picker";
import { chapterLength, previewText } from "@/ui/entities/book/time-left";
import { useBenchmark } from "@/ui/entities/benchmark/use-benchmark";
import { useBook } from "@/ui/entities/book/use-book";
import { BookHeader } from "@/ui/entities/book/BookHeader";
import { BookDeleted } from "@/ui/entities/book/BookDeleted";
import { Button } from "@/ui/shared/ui/Button";
import { LoadState } from "@/ui/shared/ui/LoadState";
import { Page } from "@/ui/shared/ui/Page";

const NOTE = "mt-2 text-[0.9rem] text-ink-muted";

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
    <Page>
      <BookHeader id={book.id} title={book.title} author={book.author} hasCover={book.hasCover} />

      <section
        className="mt-8 rounded-base border border-rule bg-paper-raised px-5 py-4"
        aria-label="Conversion settings"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label htmlFor="language" className="font-semibold">
            Language of the book
          </label>
          <select
            id="language"
            className="min-h-10 rounded-base border border-rule bg-paper px-3 py-1"
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
            hasVoice
              ? note.tone === "check"
                ? // The language is a guess the owner should look at: marked, but not an error.
                  "border-l-[3px] border-l-accent pl-3 text-ink"
                : NOTE
              : "mt-2 text-[0.9rem] text-danger"
          }
        >
          {hasVoice ? (
            <>
              {note.headline && <strong className="font-semibold">{note.headline}. </strong>}
              {note.text}
            </>
          ) : (
            `There is no ${languageName(chosen)} voice installed yet, so this book cannot be converted in ${languageName(chosen)}. Pick ${book.availableLanguages.map(languageName).join(" or ")}.`
          )}
        </p>
      </section>

      <section aria-labelledby="chapters-title" className="mt-10">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="chapters-title" className="font-serif text-[1.3rem]">
            {pluralize(book.chapterCount, "chapter")}
          </h2>
          <p className="text-[0.9rem] text-ink-muted">
            {formatWords(totalWords)}
            {estimateText && ` · ${estimateText.audio}`}
          </p>
        </div>
        <div
          className="mb-[0.9rem] grid gap-1 text-[0.9rem] text-ink-muted empty:hidden"
          role="status"
          aria-live="polite"
        >
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
        <ol className="border-t border-rule">
          {book.chapters.map((chapter, index) => (
            <li
              key={chapter.position}
              className="grid grid-cols-[2rem_1fr_auto] items-baseline gap-x-3 gap-y-1 border-b border-rule py-[0.7rem] max-sm:grid-cols-[1.5rem_1fr]"
            >
              <span className="text-right text-ink-muted tabular-nums" aria-hidden="true">
                {chapter.position}
              </span>
              <span className="font-serif text-[1.05rem] wrap-anywhere">{chapter.title}</span>
              <span className="text-right text-[0.85rem] text-ink-muted max-sm:col-[2] max-sm:text-left">
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

      <div className="sticky bottom-0 mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 bg-[linear-gradient(to_top,var(--color-paper)_70%,transparent)] py-4">
        <Button
          disabled={busy || !hasVoice || needsChoice}
          aria-describedby={needsChoice ? "language-required" : undefined}
          onClick={convert}
        >
          {busy ? "Starting…" : "Convert"}
        </Button>
        {needsChoice && (
          <p id="language-required" className={NOTE}>
            Choose the language of the book first.
          </p>
        )}
        <p className="text-danger" role="alert">
          {failure}
        </p>
      </div>
    </Page>
  );
}

/** The expected audio length of one chapter from whichever estimate is on show. */
function shownChapterSeconds(
  shown: LanguageEstimate | { chapterSeconds: (number | null)[] } | null,
  index: number,
): number | null {
  return shown?.chapterSeconds[index] ?? null;
}
