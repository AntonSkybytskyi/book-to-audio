import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { encodeWebm } from "../audio/ffmpeg.js";
import { prepareChunks } from "../convert/chapter-text.js";
import { loadConfig } from "../config.js";
import { createEngine } from "../tts/index.js";
import { inspectApp } from "./cli-app.js";
import { benchmarkVoices, workerCountsFor } from "./runner.js";
import { measureVoice } from "./measure.js";
import { currentMachine } from "./machine.js";
import { formatBenchmark } from "./table.js";
import fs from "node:fs/promises";

const USAGE = `Usage: pnpm benchmark [--workers N] [--force] [--json]

Measures the speech engine on this computer: the speech rate, the real-time factor and the
throughput with several sessions at once, for each installed voice, and prints a table.
Nothing is saved; the app has its own copy of the test on the Settings page.

  --workers N  Also compare N sessions at once (default: up to 4, and the app's worker count)
  --force      Run even though the app is busy converting (the numbers will be too low)
  --json       Print the measurements as JSON`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      workers: { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  const cpus = os.availableParallelism();
  const wanted = values.workers === undefined ? undefined : Number(values.workers);
  if (wanted !== undefined && !(Number.isInteger(wanted) && wanted >= 1 && wanted <= cpus)) {
    console.error(`--workers must be a whole number from 1 to ${cpus}.`);
    return 2;
  }
  const app = await inspectApp(config.port);
  if (app.kind === "busy" && !values.force) {
    console.error(
      `The app is busy (${app.reason}), and this would compete with it.\n` +
        "Wait until it is done, or pass --force.",
    );
    return 2;
  }
  if (app.kind === "unreachable") {
    console.error(
      `Could not reach the app on port ${config.port}, so there is no telling whether it is busy. Carrying on.`,
    );
  }

  const engine = createEngine(config);
  const voices = benchmarkVoices(engine);
  if (voices.length === 0) {
    console.error("No voice is installed, so there is nothing to measure.");
    return 1;
  }
  // The number the app really uses if it can be asked, else the environment's, else the app's default.
  const appWorkers = app.kind === "unreachable" ? null : app.workers;
  const inUse = wanted ?? appWorkers ?? config.workers ?? Math.max(1, Math.floor(cpus / 2));
  const workerCounts = workerCountsFor(Math.max(inUse, wanted ?? 0), cpus);
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-"));
  const encoder = { ffmpegBin: config.ffmpegBin, bitrate: config.opusBitrate };
  const loadAverage = os.loadavg()[0] ?? 0;
  // Ctrl-C and a termination close the engine processes instead of leaving them to find their input
  // closed; a second one does not wait for that.
  const stop = new AbortController();
  // The shell's convention: 128 plus the signal number.
  let stoppedBy = 0;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      if (stop.signal.aborted) process.exit(stoppedBy);
      stoppedBy = code;
      stop.abort();
    });
  }
  try {
    const measurements = [];
    for (const voice of voices) {
      console.error(`Measuring ${voice.id} (${workerCounts.join(", ")} sessions)...`);
      measurements.push(
        await measureVoice(
          {
            engine,
            prepare: prepareChunks,
            encode: (pcm, outputPath, signal) => encodeWebm(pcm, outputPath, encoder, signal),
            scratchDir,
            now: () => performance.now(),
          },
          voice,
          { workerCounts, signal: stop.signal },
        ),
      );
    }
    const loadEnd = os.loadavg()[0] ?? 0;
    console.log(
      values.json
        ? JSON.stringify({ machine: currentMachine(), loadAverage, loadEnd, measurements }, null, 2)
        : formatBenchmark(measurements, {
            machine: currentMachine(),
            loadAverage,
            loadEnd,
            workerCounts: [...new Set([1, 2, 4, inUse])].toSorted((a, b) => a - b),
          }),
    );
    return 0;
  } catch (error) {
    if (!stop.signal.aborted) throw error;
    console.error("Stopped.");
    return stoppedBy;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
