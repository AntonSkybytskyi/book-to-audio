"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Runs one request at a time for a button: `busy` while it is in flight, `error` with the
 * server's message when it fails. A second call while one is running does nothing, so a
 * double click cannot send the request twice.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  /** Resolves true when the request worked. */
  const run = useCallback(async (request: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await request();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Try again.");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
