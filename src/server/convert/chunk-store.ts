import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../books/storage.js";
import { DiskFullError } from "../errors.js";

/** Bumped when the chunk files change in a way that makes old ones unusable. */
const FORMAT = 1;
const META_FILE = "meta.json";
const DEFAULT_MIN_FREE_BYTES = 500 * 1024 ** 2;

/** What the finished chunks of a chapter were made with. They are only reused if all of it matches. */
export interface ChunkMeta {
  engine: string;
  voice: string;
  sampleRate: number;
  chunkCount: number;
}

export interface ChunkStoreOptions {
  /** Work stops when less than this is free on the data disk. */
  minFreeBytes?: number;
  /** Free bytes on the disk that holds `dir`. Replaced in tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

const mb = (bytes: number) => Math.round(bytes / 1024 ** 2);
const chunkName = (index: number) => `${String(index).padStart(5, "0")}.webm`;

async function freeBytesOf(dir: string): Promise<number> {
  const stats = await fsp.statfs(dir);
  return stats.bavail * stats.bsize;
}

/**
 * Finished chunks of the chapters being converted, each encoded to Opus as soon as
 * it is made, in `audio/<book>/<NN>.parts/`. The encoder writes to a temporary file
 * and renames it, so a file that exists is complete. That makes the directory the
 * source of truth for where to resume after a crash. `meta.json` records what the
 * chunks were made with; if the engine, voice, sample rate or chunk count differ,
 * they are thrown away instead of being joined with new ones.
 */
export class ChunkStore {
  private readonly minFreeBytes: number;
  private readonly freeBytes: (dir: string) => Promise<number>;

  constructor(
    private readonly storage: Storage,
    options: ChunkStoreOptions = {},
  ) {
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    this.freeBytes = options.freeBytes ?? freeBytesOf;
  }

  /**
   * Prepares the chapter's folder and returns how many chunks from the start are
   * already on disk. Throws if the book's folder is gone (the book was deleted):
   * it is never created here.
   */
  open(bookId: string, position: number, meta: ChunkMeta): number {
    const dir = this.storage.partsDir(bookId, position);
    const wanted = JSON.stringify({
      format: FORMAT,
      engine: meta.engine,
      voice: meta.voice,
      sampleRate: meta.sampleRate,
      chunkCount: meta.chunkCount,
    });
    if (readText(path.join(dir, META_FILE)) !== wanted)
      fs.rmSync(dir, { recursive: true, force: true });
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700 }); // not recursive: `audio/<book>` must exist
      const temp = path.join(dir, `.${randomUUID()}.tmp`);
      fs.writeFileSync(temp, wanted, { mode: 0o600 });
      fs.renameSync(temp, path.join(dir, META_FILE));
    }

    const names = fs.readdirSync(dir);
    const present = new Set<string>();
    for (const name of names) {
      const file = path.join(dir, name);
      if (name.endsWith(".tmp")) fs.rmSync(file, { force: true });
      else if (name.endsWith(".webm") && fs.statSync(file).size === 0)
        fs.rmSync(file, { force: true });
      else present.add(name);
    }
    let count = 0;
    while (count < meta.chunkCount && present.has(chunkName(count))) count++;
    return count;
  }

  /** Where chunk `index` goes. */
  chunkPath(bookId: string, position: number, index: number): string {
    return path.join(this.storage.partsDir(bookId, position), chunkName(index));
  }

  /** Remembers how long a finished chunk is, for when ffmpeg cannot say how long the joined file is. */
  saveDuration(bookId: string, position: number, index: number, seconds: number): void {
    fs.writeFileSync(`${this.chunkPath(bookId, position, index)}.len`, String(seconds), {
      mode: 0o600,
    });
  }

  /** The summed length of the first `count` chunks, or null if any of them is not known. */
  totalSeconds(bookId: string, position: number, count: number): number | null {
    let total = 0;
    for (let index = 0; index < count; index++) {
      const seconds = Number(readText(`${this.chunkPath(bookId, position, index)}.len`));
      if (!(seconds > 0)) return null;
      total += seconds;
    }
    return total;
  }

  /** The first `count` chunk files in order, for joining. */
  chunkPaths(bookId: string, position: number, count: number): string[] {
    return Array.from({ length: count }, (_, index) => this.chunkPath(bookId, position, index));
  }

  /** Throws `DiskFullError` when the data disk has less than the margin left. */
  async ensureSpace(): Promise<void> {
    let free: number;
    try {
      free = await this.freeBytes(this.storage.dataDir);
    } catch {
      return; // A file system that cannot say is not treated as full.
    }
    if (free < this.minFreeBytes) {
      throw new DiskFullError({
        detail: `${mb(free)} MB free on the data disk, less than the ${mb(this.minFreeBytes)} MB margin`,
      });
    }
  }

  remove(bookId: string, position: number): void {
    fs.rmSync(this.storage.partsDir(bookId, position), { recursive: true, force: true });
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
