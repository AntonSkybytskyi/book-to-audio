const pad = (n: number) => String(n).padStart(2, "0");

/** `75` becomes `1:15`, `3725` becomes `1:02:05`. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Rough listening time: `1 min`, `45 min`, `2 h 5 min`. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * A length of time as a person would say it, without false precision: whole minutes under ten,
 * five minutes up to ten hours, ten minutes beyond. `75 s` is `1 min`, `8100 s` is `2 h 15 min`,
 * and anything under a minute is `under a minute`.
 */
export function formatApprox(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = seconds / 60;
  const step = minutes < 10 ? 1 : minutes < 600 ? 5 : 10;
  return formatMinutes(Math.max(1, Math.round(minutes / step) * step));
}

/** `about 2 h 15 min`, or `under a minute`, which needs no `about`. */
export function aboutDuration(seconds: number): string {
  const text = formatApprox(seconds);
  return text === "under a minute" ? text : `about ${text}`;
}

/** File size for people: `980 KB`, `74 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1000) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatWords(words: number): string {
  return `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
