"use client";

import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

/**
 * Runs one request at a time for a button: `busy` while it is in flight, `error` with the
 * server's message when it fails. A second call while one is running does nothing, so a
 * double click cannot send the request twice.
 */
export function useGuardedMutation() {
  const mutation = useMutation({ mutationFn: (request: () => Promise<unknown>) => request() });
  const { mutateAsync, reset } = mutation;
  const inFlight = useRef(false);

  /** Resolves true when the request worked. */
  const run = useCallback(
    async (request: () => Promise<unknown>): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      try {
        await mutateAsync(request);
        return true;
      } catch {
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [mutateAsync],
  );

  const { error } = mutation;
  return {
    busy: mutation.isPending,
    error: error
      ? error instanceof Error
        ? error.message
        : "Something went wrong. Try again."
      : null,
    run,
    clearError: reset,
  };
}
