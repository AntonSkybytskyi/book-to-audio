import { parentPort, workerData } from "node:worker_threads";
import { prepareChunks } from "./chapter-text.js";

export interface TextWorkerInput {
  text: string;
  language: string;
  maxChars: number;
}

export type TextWorkerMessage = { ok: true; chunks: string[] } | { ok: false; message: string };

// worker_threads ports have no target origin, so that lint rule does not apply here.
// oxlint-disable unicorn/require-post-message-target-origin

// Runs in a worker thread (see text-preparer.ts): a book whose text makes one of the text rules
// run for too long ends this thread, not the server.
const input = workerData as TextWorkerInput;
try {
  parentPort?.postMessage({
    ok: true,
    chunks: prepareChunks(input.text, input.language, input.maxChars),
  } satisfies TextWorkerMessage);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  } satisfies TextWorkerMessage);
}
