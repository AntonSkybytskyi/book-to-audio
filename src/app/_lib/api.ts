// Client for the book-to-audio API. Mirrors the JSON in src/server/books/views.ts.

export type BookStatus = "ready" | "converting" | "paused" | "done" | "done_with_errors";
export type ChapterStatus = "pending" | "queued" | "generating" | "done" | "failed";
export type Language = "en" | "uk" | "ru";

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
}

export interface BookSummary {
  id: string;
  title: string;
  author: string | null;
  language: string;
  status: BookStatus;
  hasCover: boolean;
  createdAt: string;
  chapterCount: number;
  doneCount: number;
  failedCount: number;
  wordCount: number;
  estimatedMinutes: number;
  durationSeconds: number;
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
export const audioUrl = (id: string, position: number) =>
  `/api/books/${id}/chapters/${position}/audio`;

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
