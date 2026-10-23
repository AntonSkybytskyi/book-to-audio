import type { SpeedModel, SpeedSource } from "@book-to-audio/contracts";
import type { Language, LanguageSource } from "@/ui/entities/language/api";
import {
  ApiError,
  NETWORK_MESSAGE,
  request,
  requestSnapshot,
  toApiError,
  type Snapshot,
} from "@/ui/shared/api/request";

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";

export interface Chapter {
  position: number;
  title: string;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  charCount: number;
  wordCount: number;
  /** Characters the engine is given for the chapter; the time estimates are made from them. */
  preparedChars: number;
  /** Expected audio length until the chapter is done; null when no voice could say. */
  estimatedSeconds: number | null;
  durationSeconds: number | null;
  /** Chunks the chapter is split into (0 until it starts) and how many are finished. */
  chunkCount: number;
  chunksDone: number;
  /** There is audio to play, also while the chapter is being regenerated. */
  hasAudio: boolean;
  /** Changes when the audio is replaced; part of the audio URL so an old copy is never reused. */
  audioVersion: number;
  /** Why the last regeneration failed. The chapter is done and kept its previous audio. */
  regenError: string | null;
}

/** The M4B and ZIP of a book. Mirrors `OutputsView` in src/server/outputs/view.ts. */
export interface Outputs {
  /** `none` until a build was ever wanted. */
  state: "none" | "queued" | "building" | "ready" | "failed";
  /** The files can be downloaded now: built from the current audio, and the book is done. */
  available: boolean;
  /** Files built from older audio exist, and new ones are on their way. */
  updating: boolean;
  /** 0 to 1, while building. */
  progress: number;
  error: string | null;
  /** Only while `available`. */
  m4bBytes: number | null;
  zipBytes: number | null;
}

/** What a book that was never built looks like. */
export const NO_OUTPUTS: Outputs = {
  state: "none",
  available: false,
  updating: false,
  progress: 0,
  error: null,
  m4bBytes: null,
  zipBytes: null,
};

/** Who is ahead of a book in the queue, and how long until its turn. Mirrors `QueueView` on the server. */
export interface QueueInfo {
  booksAhead: number;
  startsInSeconds: number | null;
}

/** Length and conversion time of a book that is not finished. Mirrors `BookEstimateView`. */
export interface BookEstimate {
  audioSeconds: number;
  convertSeconds: number;
  source: SpeedSource;
  workers: number;
  queue: QueueInfo;
}

/** Time left of a converting or paused book. Mirrors `TimeLeftView`. */
export interface TimeLeft extends QueueInfo {
  state: "running" | "waiting" | "waiting_for_speed_test" | "paused" | "pool_paused";
  remainingSeconds: number | null;
  /** While `waiting_for_speed_test`: how long the speed test is expected to take yet. */
  speedTestSeconds: number | null;
  source: SpeedSource;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string | null;
  language: string;
  languageSource: LanguageSource;
  languageConfidence: number;
  /** The supported language the book's metadata names, if any. */
  declaredLanguage: string | null;
  status: BookStatus;
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  estimate: BookEstimate | null;
  /** The text is still being counted, so there is no estimate yet; the page is told when it lands. */
  measuring: boolean;
  timeLeft: TimeLeft | null;
  durationSeconds: number;
  outputs: Outputs;
}

export interface Book extends BookSummary {
  /** The speed behind the estimates, to keep the time left current as chapters progress. */
  speed: SpeedModel | null;
  chapters: Chapter[];
  availableLanguages: string[];
}

export const coverUrl = (id: string) => `/api/books/${id}/cover`;
export const audioUrl = (id: string, position: number, version: number) =>
  `/api/books/${id}/chapters/${position}/audio?v=${version}`;

export type DownloadKind = "m4b" | "zip";
export const downloadUrl = (id: string, kind: DownloadKind) => `/api/books/${id}/downloads/${kind}`;

export const getBooks = async (): Promise<Snapshot<BookSummary[]>> => {
  const { data, seq } = await requestSnapshot<{ books: BookSummary[] }>("/api/books");
  return { data: data.books, seq };
};
export const getBook = (id: string) => requestSnapshot<Book>(`/api/books/${id}`);
export const convertBook = (id: string) =>
  request<Book>(`/api/books/${id}/convert`, { method: "POST" });
export const setLanguage = (id: string, language: Language) =>
  request<Book>(`/api/books/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });

const post = (url: string) => request<Book>(url, { method: "POST" });
export const pauseBook = (id: string) => post(`/api/books/${id}/pause`);
export const resumeBook = (id: string) => post(`/api/books/${id}/resume`);
export const regenerateBook = (id: string) => post(`/api/books/${id}/regenerate`);
export const regenerateChapter = (id: string, position: number) =>
  post(`/api/books/${id}/chapters/${position}/regenerate`);

export const rebuildOutputs = (id: string) => post(`/api/books/${id}/outputs/rebuild`);

/** A book that is already gone counts as deleted. */
export async function deleteBook(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/books/${id}`, { method: "DELETE" });
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok && res.status !== 404) throw await toApiError(res);
}

/** Uploads with XMLHttpRequest, because `fetch` cannot report upload progress. */
export function uploadBook(file: File, onProgress: (fraction: number) => void): Promise<Book> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/books");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("error", () => reject(new ApiError(0, "network", NETWORK_MESSAGE)));
    xhr.addEventListener("load", () => {
      const body = xhr.response as (Book & { error?: string; message?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else {
        reject(
          new ApiError(
            xhr.status,
            body?.error ?? "unknown",
            body?.message ?? `The server answered ${xhr.status}.`,
          ),
        );
      }
    });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
