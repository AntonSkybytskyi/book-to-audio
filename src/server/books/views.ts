import type { TtsEngine } from "../tts/engine.js";
import { estimateMinutes } from "./estimate.js";
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
  estimatedMinutes: number;
  durationSeconds: number | null;
}

export interface BookSummaryView {
  id: string;
  title: string;
  author: string | null;
  language: string;
  status: BookWithTotals["status"];
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  estimatedMinutes: number;
  durationSeconds: number;
}

export interface BookView extends BookSummaryView {
  chapters: ChapterView[];
  /** Languages the TTS engine has a voice for. */
  availableLanguages: string[];
}

export const toSummaryView = (book: BookWithTotals): BookSummaryView => ({
  id: book.id,
  title: book.title,
  author: book.author,
  language: book.language,
  status: book.status,
  hasCover: book.coverPath !== null,
  createdAt: book.createdAt,
  chapterCount: book.chapterCount,
  doneCount: book.doneCount,
  failedCount: book.failedCount,
  wordCount: book.wordCount,
  estimatedMinutes: estimateMinutes(book.wordCount),
  durationSeconds: book.durationSeconds,
});

export const toChapterView = (chapter: Chapter): ChapterView => ({
  position: chapter.position,
  title: chapter.title,
  status: chapter.status,
  progress: chapter.progress,
  error: chapter.error,
  charCount: chapter.charCount,
  wordCount: chapter.wordCount,
  estimatedMinutes: estimateMinutes(chapter.wordCount),
  durationSeconds: chapter.durationSeconds,
});

/** A book with its chapters, or null when it does not exist. */
export function loadBookView(repo: BookRepository, engine: TtsEngine, id: string): BookView | null {
  const book = repo.get(id);
  if (!book) return null;
  return {
    ...toSummaryView(book),
    chapters: repo.chapters(id).map(toChapterView),
    availableLanguages: [...new Set(engine.voices().map((v) => v.language))],
  };
}
