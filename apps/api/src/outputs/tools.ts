import { runProcess, type ProcessRunner } from "../process.js";
import { BuildCancelled, NO_SPACE_MESSAGE, OutputError, ToolExit } from "./errors.js";

export interface ToolsOptions {
  ffmpegBin: string;
  ffprobeBin: string;
  run?: ProcessRunner;
  /** `nice`, to run the heavy ffmpeg jobs at a lower priority so conversion keeps the CPU; null runs them as they are. */
  niceBin?: string | null;
}

export interface FfmpegRun {
  signal: AbortSignal;
  timeoutMs: number;
  /** Gets ffmpeg's `-progress` output as it arrives. */
  onStdout?: (chunk: Buffer) => void;
  /** Runs at a lower priority (when `niceBin` is set). */
  lowPriority?: boolean;
}

const NICENESS = "10";
const PROBE_TIMEOUT_MS = 60_000;
// A line longer than this is not a packet line; keep only its end so a runaway line cannot grow without bound.
const LINE_LIMIT = 4096;

/** ffmpeg and ffprobe as the build needs them: no shell, cancellable, failures turned into messages. */
export class Tools {
  private readonly run: ProcessRunner;

  constructor(private readonly options: ToolsOptions) {
    this.run = options.run ?? runProcess;
  }

  /** Runs ffmpeg. Throws `BuildCancelled` when aborted and `OutputError` for everything else that goes wrong. */
  async ffmpeg(args: readonly string[], options: FfmpegRun): Promise<void> {
    const { ffmpegBin, niceBin } = this.options;
    const nice = options.lowPriority && niceBin;
    const result = await this.start(
      nice ? niceBin : ffmpegBin,
      nice ? ["-n", NICENESS, ffmpegBin, ...args] : args,
      options,
    );
    if (result.code !== 0) throw failure("ffmpeg", result.code, result.stderr);
  }

  /** Runs ffprobe and returns what it printed. */
  async ffprobe(args: readonly string[], signal: AbortSignal): Promise<string> {
    const result = await this.start(this.options.ffprobeBin, args, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.code !== 0) throw failure("ffprobe", result.code, result.stderr);
    return result.stdout.toString("utf8");
  }

  /**
   * Runs ffprobe and returns only the last non-empty line it printed. The output is read as it
   * arrives and thrown away, so a listing of millions of packets takes no memory.
   */
  async ffprobeLastLine(args: readonly string[], signal: AbortSignal): Promise<string | null> {
    let tail = "";
    let last: string | null = null;
    const result = await this.start(this.options.ffprobeBin, args, {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      onStdout: (chunk) => {
        const lines = (tail + chunk.toString("utf8")).split("\n");
        tail = (lines.pop() ?? "").slice(-LINE_LIMIT);
        const complete = lines.findLast((line) => line.trim() !== "");
        if (complete !== undefined) last = complete.slice(-LINE_LIMIT);
      },
    });
    if (result.code !== 0) throw failure("ffprobe", result.code, result.stderr);
    return tail.trim() !== "" ? tail : last;
  }

  private async start(command: string, args: readonly string[], options: FfmpegRun) {
    let result;
    try {
      result = await this.run(command, args, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onStdout: options.onStdout,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new OutputError(
        missing
          ? "ffmpeg is not installed, so the downloads cannot be built."
          : "The audio tool could not be started.",
        { cause: error, detail: (error as Error).message },
      );
    }
    if (result.aborted) throw new BuildCancelled();
    if (result.timedOut) throw new OutputError("Building the downloads took too long.");
    return result;
  }
}

function failure(tool: string, code: number | null, stderr: string): OutputError {
  const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  if (/no space left on device/i.test(stderr)) return new OutputError(NO_SPACE_MESSAGE);
  return new ToolExit("The downloads could not be built.", {
    detail: `${tool} exited with code ${code}: ${tail}`,
  });
}
