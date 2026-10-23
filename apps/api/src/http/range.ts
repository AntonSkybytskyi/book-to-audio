export type ByteRange = { start: number; end: number };

/**
 * Parses a `Range` header for a file of `size` bytes.
 * Returns `null` when the header should be ignored (absent, not `bytes`, or
 * several ranges, which we answer with the whole file), `"unsatisfiable"` for a
 * range outside the file, else the inclusive byte range.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;

  if (first === "") {
    // Suffix range: the last N bytes.
    const count = Number(last);
    if (count === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - count), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null; // Invalid per RFC 9110: ignore the header.
  return { start, end };
}
