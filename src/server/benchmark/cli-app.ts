/** What the running app (if any) is doing, as far as the benchmark CLI can tell from its API. */
export type AppActivity =
  | { kind: "unreachable" }
  | { kind: "idle"; workers: number | null }
  | { kind: "busy"; reason: string; workers: number | null };

export type GetJson = (url: string) => Promise<unknown>;

const defaultGet: GetJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

interface PoolBody {
  state?: string;
  activeWorkers?: number;
  held?: boolean;
}
interface BookBody {
  title?: string;
  status?: string;
  outputs?: { state?: string };
}

/**
 * Asks the app on `port` whether anything is reading, converting, building downloads or testing the
 * speed, since the benchmark would compete with it. An app that cannot be reached is `unreachable`,
 * which is not the same as idle: the CLI says so and carries on. The worker count in the settings is
 * returned too, so the benchmark compares the number the app really uses.
 */
export async function inspectApp(port: number, get: GetJson = defaultGet): Promise<AppActivity> {
  const base = `http://127.0.0.1:${port}/api`;
  let pool: PoolBody;
  try {
    pool = (await get(`${base}/pool`)) as PoolBody;
  } catch {
    return { kind: "unreachable" };
  }
  const attempt = async <T>(path: string): Promise<T | null> => {
    try {
      return (await get(`${base}${path}`)) as T;
    } catch {
      return null;
    }
  };
  const [benchmark, books, settings] = await Promise.all([
    attempt<{ state?: string }>("/benchmark"),
    attempt<{ books?: BookBody[] }>("/books"),
    attempt<{ workers?: number }>("/settings"),
  ]);
  const workers = typeof settings?.workers === "number" ? settings.workers : null;
  const busy = (reason: string): AppActivity => ({ kind: "busy", reason, workers });

  if ((pool.activeWorkers ?? 0) > 0) return busy("a chapter is being read");
  if (pool.held) return busy("the app is running its own speed test");
  if (benchmark?.state !== undefined && benchmark.state !== "idle") {
    return busy("the app is running its own speed test");
  }
  const list = books?.books ?? [];
  if (pool.state !== "paused" && list.some((book) => book.status === "converting")) {
    return busy("a book is queued for conversion");
  }
  const building = ["queued", "building"];
  if (list.some((book) => building.includes(book.outputs?.state ?? ""))) {
    return busy("the downloads of a book are being built");
  }
  return { kind: "idle", workers };
}
