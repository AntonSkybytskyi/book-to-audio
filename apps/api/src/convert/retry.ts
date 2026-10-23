/** Waits `ms`, or less when `signal` aborts. Never rejects; callers check the signal afterwards. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type Sleep = typeof sleep;

/** Pauses before the 2nd, 3rd and 4th attempt at a chunk: three retries. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 15_000];
