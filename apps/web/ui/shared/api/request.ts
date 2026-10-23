// Request helper for the book-to-audio API.

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

export const NETWORK_MESSAGE = "Could not reach the server. Check that the app is still running.";

export async function toApiError(res: Response): Promise<ApiError> {
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

export async function requestSnapshot<T>(url: string, init?: RequestInit): Promise<Snapshot<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await toApiError(res);
  return { data: (await res.json()) as T, seq: Number(res.headers.get("x-event-seq") ?? 0) };
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return (await requestSnapshot<T>(url, init)).data;
}
