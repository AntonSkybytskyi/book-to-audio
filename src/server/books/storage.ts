import fs from "node:fs";
import path from "node:path";

const COVER_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Where book files live under the data directory. Every path is built from a
 * server generated book id and a chapter position, never from user input, and
 * the database stores them relative to the data directory.
 */
export class Storage {
  constructor(readonly dataDir: string) {}

  bookDir(bookId: string): string {
    return path.join(this.dataDir, "books", bookId);
  }

  sourceRelPath(bookId: string): string {
    return path.join("books", bookId, "source.epub");
  }

  coverRelPath(bookId: string, mime: string): string | null {
    const ext = COVER_EXTENSIONS[mime];
    return ext ? path.join("books", bookId, `cover.${ext}`) : null;
  }

  audioDir(bookId: string): string {
    return path.join(this.dataDir, "audio", bookId);
  }

  audioRelPath(bookId: string, position: number): string {
    return path.join("audio", bookId, `${String(position).padStart(2, "0")}.webm`);
  }

  /** Absolute path for a relative path stored in the database. */
  resolve(relPath: string): string {
    const full = path.resolve(this.dataDir, relPath);
    if (!full.startsWith(this.dataDir + path.sep)) {
      throw new Error(`path escapes the data directory: ${relPath}`);
    }
    return full;
  }

  ensureBookDir(bookId: string): string {
    const dir = this.bookDir(bookId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  ensureAudioDir(bookId: string): string {
    const dir = this.audioDir(bookId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Removes everything stored for a book. Used when an upload fails half way. */
  removeBookFiles(bookId: string): void {
    fs.rmSync(this.bookDir(bookId), { recursive: true, force: true });
    fs.rmSync(this.audioDir(bookId), { recursive: true, force: true });
  }
}
