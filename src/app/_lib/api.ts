// Client for the book-to-audio API. Mirrors the JSON in src/server/books/views.ts.

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";
export type Language = "en" | "uk" | "ru";
/** Where a book's language came from; `unknown` means English is only a placeholder. */
export type LanguageSource = "detected" | "metadata" | "unknown" | "chosen";

export interface Chapter {
  position: number;
  title: string;
  status: ChapterStatus;
  progress: number;
  error: string | null;
  charCount: number;
  wordCount: number;
  estimatedMinutes: number;
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
  estimatedMinutes: number;
  durationSeconds: number;
  outputs: Outputs;
}

export interface Book extends BookSummary {
  chapters: Chapter[];
  availableLanguages: string[];
}

export interface PoolStatus {
  /** `paused` until the owner resumes: after three chapters failed in a row, or when the disk is full. */
  state: "running" | "paused";
  /** Why the pool paused. */
  error: string | null;
  cause: "failures" | "disk" | null;
  workers: number;
  activeWorkers: number;
}

export interface Settings {
  workers: number;
  maxWorkers: number;
  defaultWorkers: number;
  /** The languages the language picker offers. */
  shownLanguages: Language[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const NETWORK_MESSAGE = "Could not reach the server. Check that the app is still running.";

async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  return new ApiError(
    res.status,
    body?.error ?? "unknown",
    body?.message ?? `The server answered ${res.status}.`,
  );
}

/** Data with the sequence number of the newest live event it can include. */
export interface Snapshot<T> {
  data: T;
  seq: number;
}

async function requestSnapshot<T>(url: string, init?: RequestInit): Promise<Snapshot<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await toApiError(res);
  return { data: (await res.json()) as T, seq: Number(res.headers.get("x-event-seq") ?? 0) };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return (await requestSnapshot<T>(url, init)).data;
}

export const coverUrl = (id: string) => `/api/books/${id}/cover`;
export const audioUrl = (id: string, position: number, version: number) =>
  `/api/books/${id}/chapters/${position}/audio?v=${version}`;

export type DownloadKind = "m4b" | "zip";
export const downloadUrl = (id: string, kind: DownloadKind) => `/api/books/${id}/downloads/${kind}`;

export const getConfig = () => request<{ maxUploadMb: number }>("/api/config");
export const getPool = () => requestSnapshot<PoolStatus>("/api/pool");
export const resumePool = () => requestSnapshot<PoolStatus>("/api/pool/resume", { method: "POST" });
export const getSettings = () => requestSnapshot<Settings>("/api/settings");
export const saveWorkers = (workers: number) =>
  request<Settings>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workers }),
  });
export const saveShownLanguages = (shownLanguages: Language[]) =>
  request<Settings>("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shownLanguages }),
  });
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
