import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface RunOptions {
  /** Written to stdin, which is then closed. An iterable is streamed, so it is never held whole. */
  input?: Buffer | string | AsyncIterable<Buffer>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Output beyond this is an error, so a runaway process cannot fill memory. */
  maxStdoutBytes?: number;
  /** Gets stdout as it arrives instead of it being collected (`RunResult.stdout` is then empty): for progress reports. */
  onStdout?: (chunk: Buffer) => void;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  /** The last part of stderr, enough to explain a failure. */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Runs a command and collects its output. Injected so callers can be tested without binaries. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

const STDERR_TAIL_BYTES = 16 * 1024;
const DEFAULT_MAX_STDOUT = 512 * 1024 ** 2;

/**
 * Spawns without a shell, so arguments are never interpreted. Rejects when the
 * process cannot start (for example ENOENT) or writes too much to stdout.
 */
export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true });
      return;
    }
    const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let inputError: unknown = null;

    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) {
        options.onStdout(chunk);
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        overflow = true;
        kill();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("close", (code) => {
      cleanup();
      if (overflow) reject(new Error(`${command} wrote more than ${maxStdout} bytes to stdout`));
      // Input that broke half way would otherwise look like input that ended.
      else if (inputError) {
        reject(
          new Error(`input for ${command} failed: ${(inputError as Error).message}`, {
            cause: inputError,
          }),
        );
      } else resolve({ code, stdout: Buffer.concat(stdout), stderr, timedOut, aborted });
    });

    // The process may exit before reading all of its input.
    child.stdin.on("error", () => {});
    const { input } = options;
    if (input === undefined || typeof input === "string" || Buffer.isBuffer(input)) {
      child.stdin.end(input);
    } else {
      const chunks = input;
      // Only a failure of the source counts as an input error; the process closing its
      // stdin early (EPIPE, thrown in at the yield below) is not one.
      async function* watched() {
        const iterator = chunks[Symbol.asyncIterator]();
        try {
          for (;;) {
            let step: IteratorResult<Buffer>;
            try {
              step = await iterator.next();
            } catch (error) {
              inputError = error;
              throw error;
            }
            if (step.done) return;
            yield step.value;
          }
        } finally {
          await iterator.return?.();
        }
      }
      // Failures on the stdin side (the process went away) are not input errors.
      pipeline(Readable.from(watched(), { objectMode: false }), child.stdin).catch(() => {});
    }
  });
