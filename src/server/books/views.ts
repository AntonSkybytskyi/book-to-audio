import type { TtsEngine } from "../tts/engine.js";
import { toOutputsView, type OutputsView } from "../outputs/view.js";
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
  status: BookWithTotals["status"];
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  estimatedMinutes: number;
  durationSeconds: number;
  /** The M4B and ZIP: whether they can be downloaded, are being built or failed. */
  outputs: OutputsView;
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
  outputs: toOutputsView(book.status, book.audioGeneration, book.outputs),
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
  chunkCount: chapter.chunkCount,
  chunksDone: chapter.chunksDone,
  hasAudio: chapter.audioPath !== null,
  audioVersion: chapter.audioVersion,
  regenError: chapter.regenError,
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
