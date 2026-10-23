import type { TtsEngine } from "../tts/engine.js";
import { toOutputsView, type OutputsView } from "../outputs/view.js";
import { audioSecondsFor, type SpeedModel } from "@book-to-audio/contracts";
import type {
  BookEstimates,
  BookEstimateView,
  Estimator,
  TimeLeftView,
} from "../speed/estimator.js";
import type { BookRepository, BookWithTotals, Chapter } from "./repository.js";

/** What the API returns. Never includes file paths or chapter text. */
export interface ChapterView {
  position: number;
  title: string;
  status: Chapter["status"];
  progress: number;
  error: string | null;
  charCount: number;
  wordCount: number;
  /** Characters the engine is given for the chapter; what the time estimates are made from. */
  preparedChars: number;
  /** How long the chapter will be read aloud, before it is done; null when no voice could say. */
  estimatedSeconds: number | null;
  durationSeconds: number | null;
  /** Chunks the chapter is split into (0 until it starts) and how many are finished. */
  chunkCount: number;
  chunksDone: number;
  /** There is audio to play: also true while the chapter is regenerated, or after a failed retry. */
  hasAudio: boolean;
  /** Changes when the audio is replaced; the player puts it in the audio URL. */
  audioVersion: number;
  /** Why the last regeneration failed. The chapter is `done` and kept its previous audio. */
  regenError: string | null;
}

export interface BookSummaryView {
  id: string;
  title: string;
  author: string | null;
  language: string;
  /** How `language` was found: from the text, the metadata, not at all, or chosen by the owner. */
  languageSource: BookWithTotals["languageSource"];
  languageConfidence: number;
  /** The supported language the book's metadata names, if any. */
  declaredLanguage: string | null;
  status: BookWithTotals["status"];
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  /** Length and conversion time for a book that is not finished; null once it is, without a voice, or while measuring. */
  estimate: BookEstimateView | null;
  /** The text is still being counted, so there is no estimate yet; it arrives by itself (`book-counted`). */
  measuring: boolean;
  /** Only while the book is converting or paused. */
  timeLeft: TimeLeftView | null;
  durationSeconds: number;
  /** The M4B and ZIP: whether they can be downloaded, are being built or failed. */
  outputs: OutputsView;
}

export interface BookView extends BookSummaryView {
  /** The speed behind `estimate`, so the page can keep the time left current as chapters progress. */
  speed: SpeedModel | null;
  chapters: ChapterView[];
  /** Languages the TTS engine has a voice for. */
  availableLanguages: string[];
}

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
  engine: TtsEngine,
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
    availableLanguages: [...new Set(engine.voices().map((v) => v.language))],
  };
}
