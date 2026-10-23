import { Worker } from "node:worker_threads";
import { TtsError } from "../tts/engine.js";
import type { TextPreparer } from "./chapter-text.js";
import type { TextWorkerInput, TextWorkerMessage } from "./text-worker.js";

export interface TextPreparerOptions {
  /** Time allowed for a small chapter; every 100,000 characters add one second. */
  baseTimeoutMs?: number;
  /** V8 heap cap of the thread. */
  maxOldGenerationSizeMb?: number;
  /** For tests. Defaults to `text-worker.js` (or `.ts` when running from source). */
  workerUrl?: URL;
  execArgv?: string[];
}

const TOO_LONG = "The text of this chapter could not be prepared for reading in time.";

/**
 * Prepares each chapter's text in its own worker thread with a memory cap and a time limit, so a
 * pathological text (a regular expression that runs away) cannot freeze the server. A chapter that
 * runs over fails with `bad_input`, which is the text's fault and not counted against the engine.
 */
export function createTextPreparer(options: TextPreparerOptions = {}): TextPreparer {
  const {
    baseTimeoutMs = 20_000,
    maxOldGenerationSizeMb = 512,
    workerUrl = new URL(
      `./text-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
      import.meta.url,
    ),
    execArgv,
  } = options;

  return (text, language, maxChars, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new TtsError("aborted", "Conversion was cancelled"));
      const input: TextWorkerInput = { text, language, maxChars };
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
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        action();
      };
      const fail = (detail: string) =>
        finish(() => reject(new TtsError("bad_input", TOO_LONG, { detail })));
      const timeoutMs = baseTimeoutMs + Math.floor(text.length / 100_000) * 1000;
      const timer = setTimeout(
        () => fail(`text rules ran longer than ${timeoutMs / 1000} s`),
        timeoutMs,
      );
      const onAbort = () =>
        finish(() => reject(new TtsError("aborted", "Conversion was cancelled")));
      signal?.addEventListener("abort", onAbort, { once: true });

      worker.once("message", (message: TextWorkerMessage) =>
        finish(() => {
          if (message.ok) resolve(message.chunks);
          else reject(new TtsError("bad_input", TOO_LONG, { detail: message.message }));
        }),
      );
      worker.once("error", (error: NodeJS.ErrnoException) =>
        fail(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "text rules ran out of memory"
            : error.message,
        ),
      );
      worker.once("exit", (code) => fail(`the text worker stopped (exit code ${code})`));
    });
}
