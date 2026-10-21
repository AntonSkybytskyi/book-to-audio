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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export const coverUrl = (id: string) => `/api/books/${id}/cover`;
export const audioUrl = (id: string, position: number) =>
  `/api/books/${id}/chapters/${position}/audio`;

export const getConfig = () => request<{ maxUploadMb: number }>("/api/config");
export const getBooks = async () => (await request<{ books: BookSummary[] }>("/api/books")).books;
export const getBook = (id: string) => request<Book>(`/api/books/${id}`);
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
