import type { BookListView, BookSummaryView, BookView } from "@book-to-audio/contracts";
import type { Language } from "@/ui/entities/language/api";
import {
  ApiError,
  NETWORK_MESSAGE,
  request,
  requestSnapshot,
  toApiError,
  type Snapshot,
} from "@/ui/shared/api/request";

// The API's own types, under the names the pages use.
export type {
  BookStatus,
  ChapterStatus,
  ChapterView as Chapter,
  OutputsView as Outputs,
  QueueView as QueueInfo,
  BookEstimateView as BookEstimate,
  TimeLeftView as TimeLeft,
  BookSummaryView as BookSummary,
  BookView as Book,
} from "@book-to-audio/contracts";
export { NO_OUTPUTS } from "@book-to-audio/contracts";

export const coverUrl = (id: string) => `/api/books/${id}/cover`;
export const audioUrl = (id: string, position: number, version: number) =>
  `/api/books/${id}/chapters/${position}/audio?v=${version}`;

export type DownloadKind = "m4b" | "zip";
export const downloadUrl = (id: string, kind: DownloadKind) => `/api/books/${id}/downloads/${kind}`;

export const getBooks = async (): Promise<Snapshot<BookSummaryView[]>> => {
  const { data, seq } = await requestSnapshot<BookListView>("/api/books");
  return { data: data.books, seq };
};
export const getBook = (id: string) => requestSnapshot<BookView>(`/api/books/${id}`);
export const convertBook = (id: string) =>
  request<BookView>(`/api/books/${id}/convert`, { method: "POST" });
export const setLanguage = (id: string, language: Language) =>
  request<BookView>(`/api/books/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });

const post = (url: string) => request<BookView>(url, { method: "POST" });
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
export function uploadBook(file: File, onProgress: (fraction: number) => void): Promise<BookView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/books");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("error", () => reject(new ApiError(0, "network", NETWORK_MESSAGE)));
    xhr.addEventListener("load", () => {
      const body = xhr.response as (BookView & { error?: string; message?: string }) | null;
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
