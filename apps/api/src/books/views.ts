import type { TtsCatalog } from "../tts/catalog.js";
import { toOutputsView } from "../outputs/view.js";
import {
  audioSecondsFor,
  type BookSummaryView,
  type BookView,
  type ChapterView,
  type SpeedModel,
} from "@book-to-audio/contracts";
import type { BookEstimates, Estimator } from "../speed/estimator.js";
import type { BookRepository, BookWithTotals, Chapter } from "./repository.js";

export const toSummaryView = (
  book: BookWithTotals,
  estimates?: Pick<BookEstimates, "estimate" | "measuring" | "timeLeft">,
): BookSummaryView => ({
  id: book.id,
  title: book.title,
  author: book.author,
  language: book.language,
  languageSource: book.languageSource,
  languageConfidence: book.languageConfidence,
  declaredLanguage: book.declaredLanguage,
  status: book.status,
  hasCover: book.coverPath !== null,
  createdAt: book.createdAt,
  chapterCount: book.chapterCount,
  doneCount: book.doneCount,
  failedCount: book.failedCount,
  wordCount: book.wordCount,
  estimate: estimates?.measuring ? null : (estimates?.estimate ?? null),
  measuring: estimates?.measuring ?? false,
  timeLeft: estimates?.timeLeft ?? null,
  durationSeconds: book.durationSeconds,
  outputs: toOutputsView(book.status, book.audioGeneration, book.outputs),
});

export const toChapterView = (chapter: Chapter, speed: SpeedModel | null): ChapterView => ({
  position: chapter.position,
  title: chapter.title,
  status: chapter.status,
  progress: chapter.progress,
  error: chapter.error,
  charCount: chapter.charCount,
  wordCount: chapter.wordCount,
  preparedChars: chapter.preparedChars,
  estimatedSeconds: speed && chapter.counted ? audioSecondsFor(speed, chapter.preparedChars) : null,
  durationSeconds: chapter.durationSeconds,
  chunkCount: chapter.chunkCount,
  chunksDone: chapter.chunksDone,
  hasAudio: chapter.audioPath !== null,
  audioVersion: chapter.audioVersion,
  regenError: chapter.regenError,
});

/** The summaries of the library, with the estimates of the books that are not finished. */
export function loadSummaries(repo: BookRepository, estimator: Estimator): BookSummaryView[] {
  const estimates = estimator.forBooks(repo.workload());
  return repo.list().map((book) => toSummaryView(book, estimates.get(book.id)));
}

/** A book with its chapters, or null when it does not exist. */
export function loadBookView(
  repo: BookRepository,
  catalog: TtsCatalog,
  estimator: Estimator,
  id: string,
): BookView | null {
  const book = repo.get(id);
  if (!book) return null;
  const estimates = estimator.forBooks(repo.workload()).get(id);
  return {
    ...toSummaryView(book, estimates),
    speed: estimates?.speed ?? null,
    chapters: repo.chapters(id).map((chapter) => toChapterView(chapter, estimates?.speed ?? null)),
    availableLanguages: catalog.availableLanguages(),
  };
}
