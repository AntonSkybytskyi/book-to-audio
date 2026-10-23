import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TtsError } from "./errors.js";
import type { PcmAudio } from "./wav.js";

export interface PiperSessionOptions {
  bin: string;
  modelPath: string;
  sampleRate: number;
  /** The speaker of a multi-speaker model; sent with every chunk. */
  speakerId?: number;
  /** Folder for the scratch directories of sessions; created private to this user if missing. */
  scratchRoot: string;
  /** Longest wait for one chunk. */
  timeoutMs: number;
  /** Extra wait for the first chunk, which also pays for starting the process and loading the model. */
  startupGraceMs: number;
}

interface Pending {
  outputFile: string;
  settle(error?: Error): void;
}

const STDERR_TAIL_BYTES = 4 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
/** How long Piper gets to exit after its input is closed before it is killed. */
const CLOSE_GRACE_MS = 1500;

/**
 * One long-lived Piper process for one voice. Chunks go in as JSON lines on
 * stdin (`--json-input`); Piper writes each one to a WAV file and prints the
 * file's path on stdout when it is complete. The model loads once, at the
 * first chunk, instead of for every chunk. One chunk at a time; a session that throws
 * is broken: close it and open a new one.
 */
export class PiperSession {
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exited: Promise<void>;
  private pending: Pending | null = null;
  private stdoutRest = "";
  private stderr = "";
  private sequence = 0;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly tmpDir: string,
    private readonly options: PiperSessionOptions,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.exit = { code, signal };
        this.pending?.settle(this.stoppedError());
        resolve();
      });
    });
    child.stdout.on("data", (data: Buffer) => this.onStdout(data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    // The process may exit before reading a line; the close event reports that.
    child.stdin.on("error", () => {});
    child.on("error", () => {});
  }

  /** Starts the process. Rejects when the binary cannot be run. */
  static async open(options: PiperSessionOptions): Promise<PiperSession> {
    await ensurePrivateDir(options.scratchRoot);
    const tmpDir = await fs.mkdtemp(path.join(options.scratchRoot, "session-"));
    // Piper resolves a relative `output_file` against its working directory, not
    // `--output_dir`, so every request below uses an absolute path.
    const args = ["--model", options.modelPath, "--json-input", "--output_dir", tmpDir];
    // Its own process group, so `kill` can take a wrapper script's children down with it.
    const child = spawn(options.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TtsError("engine_unavailable", "The speech engine (Piper) is not installed.", {
          cause: error,
          detail: `"${options.bin}" was not found`,
        });
      }
      throw new TtsError("synthesis_failed", "The speech engine could not be started.", {
        cause: error,
        detail: (error as Error).message,
      });
    }
    return new PiperSession(child, tmpDir, options);
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio> {
    if (this.exit || this.closing) throw this.stoppedError();
    if (this.pending) throw new Error("A Piper session handles one chunk at a time");
    if (signal?.aborted) throw new TtsError("aborted", "Synthesis was cancelled");

    const outputFile = path.join(this.tmpDir, `${++this.sequence}.wav`);
    const timeoutMs =
      this.options.timeoutMs + (this.sequence === 1 ? this.options.startupGraceMs : 0);
    const finished = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        this.kill();
        finish(
          new TtsError("timeout", "The speech engine took too long on this chapter.", {
            detail: `Piper took longer than ${timeoutMs / 1000} s on one chunk`,
          }),
        );
      }, timeoutMs);
      // A line that is already being synthesized cannot be cancelled, so the process goes.
      const onAbort = () => {
        this.kill();
        finish(new TtsError("aborted", "Synthesis was cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = { outputFile, settle: finish };
    });

    // A JSON string keeps paragraph breaks on one line.
    const request: Record<string, unknown> = { text: text.trim(), output_file: outputFile };
    if (this.options.speakerId !== undefined) request.speaker_id = this.options.speakerId;
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    try {
      await finished;
      return {
        sampleRate: this.options.sampleRate,
        channels: 1,
        samples: await readPcm(outputFile),
      };
    } finally {
      await fs.rm(outputFile, { force: true });
    }
  }

  /** Ends the process and removes its scratch directory. */
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    this.pending?.settle(new TtsError("aborted", "The speech engine was closed"));
    if (!this.exit) {
      // Closing stdin makes Piper finish and exit; the timer is for one that does not.
      const timer = setTimeout(() => this.kill(), CLOSE_GRACE_MS);
      this.child.stdin.end();
      await this.exited;
      clearTimeout(timer);
    }
    await fs.rm(this.tmpDir, { recursive: true, force: true });
  }

  private kill(): void {
    if (this.exit) return;
    try {
      if (this.child.pid !== undefined) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  private onStdout(data: string): void {
    const lines = (this.stdoutRest + data).split("\n");
    // A process that never ends a line must not make this grow without bound.
    this.stdoutRest = (lines.pop() ?? "").slice(-MAX_LINE_CHARS);
    for (const line of lines) {
      if (this.pending && line.trim() === this.pending.outputFile) this.pending.settle();
    }
  }

  private stoppedError(): TtsError {
    const tail = this.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    const how = this.exit
      ? `exited with ${this.exit.signal ?? `code ${this.exit.code}`}`
      : "was closed";
    return new TtsError("synthesis_failed", "The speech engine stopped unexpectedly.", {
      detail: `Piper ${how}: ${tail}`,
    });
  }
}

/** The samples of a 16-bit PCM WAV file, without the header. */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF") {
    throw new TtsError("synthesis_failed", "The speech engine produced no audio.");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "data") {
      // A streamed WAV can leave the size unset; then the data runs to the end.
      const end = size === 0 || start + size > wav.length ? wav.length : start + size;
      return wav.subarray(start, end - ((end - start) % 2));
    }
    offset = start + size + (size % 2);
  }
  throw new TtsError("synthesis_failed", "The speech engine produced no audio.");
}

async function readPcm(file: string): Promise<Buffer> {
  const samples = wavToPcm(await fs.readFile(file));
  if (samples.length === 0) {
    throw new TtsError("bad_input", "The speech engine produced no audio for this text.");
  }
  return samples;
}

/**
 * Makes sure `dir` exists and only this user can use it: it holds book text as WAV
 * files, and a directory someone else owns (or a symlink to one) is not to be trusted.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  const uid = process.getuid?.();
  const ours = uid === undefined || stat.uid === uid;
  if (!stat.isDirectory() || !ours || (stat.mode & 0o077) !== 0) {
    throw new TtsError("engine_unavailable", "The speech engine's scratch folder is not private.", {
      detail: `${dir} must be a real directory owned by this user with mode 700`,
    });
  }
}
