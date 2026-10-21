import fs from "node:fs";
import path from "node:path";

const COVER_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;

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

  /** Where the finished chunks of a chapter wait until the chapter is encoded. */
  partsDir(bookId: string, position: number): string {
    return path.join(this.audioDir(bookId), `${String(position).padStart(2, "0")}.parts`);
  }

  /** Removes the saved chunks of one chapter. */
  removeParts(bookId: string, position: number): void {
    fs.rmSync(this.partsDir(bookId, position), RM_OPTIONS);
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

  /**
   * The folders under the data directory that hold one `<book id>` folder per book. Deleting
   * a book and the startup sweep both go through this list: a new kind of per-book files
   * (the M4B and ZIP outputs) is added here, and nowhere else.
   */
  get bookAreas(): readonly string[] {
    return ["books", "audio"];
  }

  /** Where `area` keeps the files of one book. */
  areaDir(area: string, bookId: string): string {
    return path.join(this.dataDir, area, bookId);
  }

  /**
   * Removes everything stored for a book: the upload, the cover, finished chapters, saved
   * chunks and temporary files. Every folder is tried even if the first cannot be removed;
   * the first error is thrown afterwards. Whatever stays behind belongs to no book, so the
   * startup sweep removes it.
   */
  removeBookFiles(bookId: string): void {
    let failure: unknown = null;
    for (const area of this.bookAreas) {
      try {
        fs.rmSync(this.areaDir(area, bookId), RM_OPTIONS);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}
