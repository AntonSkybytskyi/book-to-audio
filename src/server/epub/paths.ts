import path from "node:path";

export interface ResolvedHref {
  /** Normalised entry name inside the archive. */
  path: string;
  fragment: string | null;
}

/**
 * Resolves an href found in `baseFile` to an archive entry name. Returns null
 * for external links, empty hrefs and anything that climbs out of the archive.
 */
export function resolveHref(baseFile: string, href: string): ResolvedHref | null {
  const trimmed = href.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

  const hash = trimmed.indexOf("#");
  const rawPath = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const rawFragment = hash === -1 ? "" : trimmed.slice(hash + 1);

  const decodedPath = safeDecode(rawPath);
  const target = decodedPath
    ? path.posix.normalize(
        decodedPath.startsWith("/")
          ? decodedPath.slice(1)
          : path.posix.join(path.posix.dirname(baseFile), decodedPath),
      )
    : baseFile;
  if (target === ".." || target.startsWith("../") || target.startsWith("/")) return null;

  return { path: target, fragment: rawFragment ? safeDecode(rawFragment) : null };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
