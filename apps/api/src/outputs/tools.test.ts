import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunResult } from "../process.js";
import { BuildCancelled, ToolExit } from "./errors.js";
import { Tools } from "./tools.js";

const done = (overrides: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: Buffer.alloc(0),
  stderr: "",
  timedOut: false,
  aborted: false,
  ...overrides,
});

const signal = new AbortController().signal;

/** A runner that prints `chunks` to the listener, as ffprobe would, and collects nothing. */
const printing =
  (chunks: string[], result: Partial<RunResult> = {}): ProcessRunner =>
  async (_command, _args, options) => {
    for (const chunk of chunks) options.onStdout?.(Buffer.from(chunk));
    return done(result);
  };

const tools = (run: ProcessRunner, niceBin: string | null = null) =>
  new Tools({ ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe", run, niceBin });

describe("Tools.ffprobeLastLine", () => {
  it("returns the last line however the output is cut into chunks", async () => {
    const line = await tools(
      printing(["0.0,0.02,\n1.5,0", ".02,\n3.25,0.02", ",\n"]),
    ).ffprobeLastLine([], signal);

    expect(line).toBe("3.25,0.02,");
  });

  it("returns a last line that has no newline, and skips blank lines at the end", async () => {
    expect(await tools(printing(["1,2,\n3,4,"])).ffprobeLastLine([], signal)).toBe("3,4,");
    expect(await tools(printing(["1,2,\n3,4,\n\n \n"])).ffprobeLastLine([], signal)).toBe("3,4,");
  });

  it("returns null when ffprobe printed nothing", async () => {
    expect(await tools(printing([])).ffprobeLastLine([], signal)).toBeNull();
    expect(await tools(printing(["\n\n"])).ffprobeLastLine([], signal)).toBeNull();
  });

  it("keeps nothing but the last line, however much is printed and however long a line is", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `${i}.0,0.02,\n`.repeat(200));
    const huge = "9".repeat(50_000);

    expect(await tools(printing(many)).ffprobeLastLine([], signal)).toBe(
      "199.0,0.02,".replace("199", "4999"),
    );
    const line = await tools(printing(["1,2,\n", huge, huge])).ffprobeLastLine([], signal);
    expect(line?.length).toBeLessThanOrEqual(4096);
  });

  it("throws a tool error when ffprobe exits with an error, and a cancel when it was aborted", async () => {
    await expect(
      tools(printing(["1,2,\n"], { code: 1, stderr: "Invalid data" })).ffprobeLastLine([], signal),
    ).rejects.toBeInstanceOf(ToolExit);
    await expect(
      tools(printing([], { code: null, aborted: true })).ffprobeLastLine([], signal),
    ).rejects.toBeInstanceOf(BuildCancelled);
  });
});

describe("Tools.ffmpeg", () => {
  it("runs through nice only when asked to run at a low priority", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return done();
    };

    await tools(run, "nice").ffmpeg(["-i", "x"], { signal, timeoutMs: 1000, lowPriority: true });
    await tools(run, "nice").ffmpeg(["-i", "x"], { signal, timeoutMs: 1000 });

    expect(calls[0]).toEqual({ command: "nice", args: ["-n", "10", "ffmpeg", "-i", "x"] });
    expect(calls[1]).toEqual({ command: "ffmpeg", args: ["-i", "x"] });
  });
});
