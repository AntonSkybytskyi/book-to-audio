import { parentPort, workerData } from "node:worker_threads";
import { EpubError, type EpubErrorCode } from "./errors.js";
import { parseEpubFile } from "./parse.js";
import type { ParsedEpub, ParseLimits } from "./types.js";

export interface WorkerInput {
  filePath: string;
  limits: ParseLimits;
}

export type WorkerMessage =
  | { ok: true; result: ParsedEpub }
  | { ok: false; code: EpubErrorCode | null; message: string };

// worker_threads ports have no target origin, so that lint rule does not apply here.
// oxlint-disable unicorn/require-post-message-target-origin

// Runs in a worker thread (see worker-parser.ts), so a hostile file that eats
// memory ends this thread instead of the server.
const input = workerData as WorkerInput;
parseEpubFile(input.filePath, input.limits).then(
  (result) => parentPort?.postMessage({ ok: true, result } satisfies WorkerMessage),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      code: error instanceof EpubError ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerMessage),
);
