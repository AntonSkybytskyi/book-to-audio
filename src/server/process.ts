import { spawn } from "node:child_process";

export interface RunOptions {
  /** Written to stdin, which is then closed. */
  input?: Buffer | string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Output beyond this is an error, so a runaway process cannot fill memory. */
  maxStdoutBytes?: number;
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
      else resolve({ code, stdout: Buffer.concat(stdout), stderr, timedOut, aborted });
    });

    // The process may exit before reading all of its input.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
