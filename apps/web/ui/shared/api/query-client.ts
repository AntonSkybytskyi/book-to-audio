import { hashKey, QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "./request";
import { SeqGate } from "./seq-gate";

/** A lost connection or a server error may pass; a 404 will not. */
export const isTransient = (error: unknown) =>
  error instanceof ApiError ? error.status === 0 || error.status >= 500 : true;

// One gate per query, so every component that shows the same data shares what has been applied.
const gates = new WeakMap<QueryClient, Map<string, SeqGate>>();

export function gateFor(client: QueryClient, key: QueryKey): SeqGate {
  let forClient = gates.get(client);
  if (!forClient) {
    forClient = new Map();
    gates.set(client, forClient);
  }
  const hash = hashKey(key);
  let gate = forClient.get(hash);
  if (!gate) {
    gate = new SeqGate();
    forClient.set(hash, gate);
  }
  return gate;
}

/**
 * The browser does all the fetching. A query is dropped when nothing shows it, so a page
 * loads fresh when it opens, and nothing refetches by itself: polling, live events and
 * explicit refreshes decide when to load again.
 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  client.getQueryCache().subscribe((event) => {
    if (event.type === "removed") gates.get(client)?.delete(hashKey(event.query.queryKey));
  });
  return client;
}
