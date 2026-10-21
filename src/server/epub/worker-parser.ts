import { Worker } from "node:worker_threads";
import { EpubError } from "./errors.js";
import type { WorkerInput, WorkerMessage } from "./worker.js";
import { DEFAULT_LIMITS, type EpubCover, type ParsedEpub, type ParseLimits } from "./types.js";

export interface WorkerParserOptions {
  limits?: ParseLimits;
  /** V8 heap cap of the parser thread. Going over ends the thread, not the server. */
  maxOldGenerationSizeMb?: number;
  timeoutMs?: number;
  /** Uploads allowed to wait for the parser; more than this are refused. */
  maxQueued?: number;
  /** For tests. Defaults to `worker.js` (or `worker.ts` when running from source). */
  workerUrl?: URL;
  execArgv?: string[];
}

/** Too many uploads are already waiting to be read. */
export class ParserBusyError extends Error {
  constructor() {
    super("Other books are being read right now. Try again in a moment.");
    this.name = "ParserBusyError";
  }
}

const OVERLOADED = "This EPUB is too large or too complex to read.";

/**
 * Parses EPUB files one at a time, each in its own worker thread with a memory
 * cap and a time limit. Takes the path of the stored upload, so the server
 * never holds the whole file in memory.
 */
export function createWorkerParser(options: WorkerParserOptions = {}) {
  const {
    limits = DEFAULT_LIMITS,
    maxOldGenerationSizeMb = 512,
    timeoutMs = 120_000,
    maxQueued = 3,
    workerUrl = new URL(
      `./worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
      import.meta.url,
    ),
    execArgv,
  } = options;

  let running = false;
  const waiting: (() => void)[] = [];

  const acquire = async () => {
    if (!running) {
      running = true;
      return;
    }
    if (waiting.length >= maxQueued) throw new ParserBusyError();
    // The slot is handed over directly, so `running` stays true.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running = false;
  };

  const run = (filePath: string) =>
    new Promise<ParsedEpub>((resolve, reject) => {
      const input: WorkerInput = { filePath, limits };
      const worker = new Worker(workerUrl, {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb },
        ...(execArgv ? { execArgv } : {}),
      });
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        action();
      };
      const timer = setTimeout(
        () => finish(() => reject(new EpubError("unsafe_archive", OVERLOADED))),
        timeoutMs,
      );

      worker.once("message", (message: WorkerMessage) =>
        finish(() => {
          if (message.ok) resolve(revive(message.result));
          else if (message.code) reject(new EpubError(message.code, message.message));
          else reject(new Error(message.message));
        }),
      );
      worker.once("error", (error: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            error.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? new EpubError("unsafe_archive", OVERLOADED, { cause: error })
              : error,
          ),
        ),
      );
      worker.once("exit", (code) =>
        finish(() =>
          reject(new Error(`The EPUB parser stopped unexpectedly (exit code ${code}).`)),
        ),
      );
    });

  return async (filePath: string): Promise<ParsedEpub> => {
    await acquire();
    try {
      return await run(filePath);
    } finally {
      release();
    }
  };
}

/** Structured clone turns a Buffer into a plain Uint8Array; turn it back. */
function revive(epub: ParsedEpub): ParsedEpub {
  const cover: EpubCover | null = epub.cover && {
    ...epub.cover,
    bytes: Buffer.from(
      epub.cover.bytes.buffer,
      epub.cover.bytes.byteOffset,
      epub.cover.bytes.length,
    ),
  };
  return { ...epub, cover };
}
