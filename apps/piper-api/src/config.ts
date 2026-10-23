import os from "node:os";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  /** The `piper` executable, a name on PATH or a path. */
  piperBin: string;
  /** Directory with Piper voice models (`.onnx` and `.onnx.json`). */
  voicesDir: string;
  /** Requests handled at once, which is also the most Piper processes alive at once. */
  concurrency: number;
  /** Longest wait for one chunk, not counting time in the queue. */
  timeoutMs: number;
  /** Extra wait for the first chunk of a process, which loads the model. */
  startupGraceMs: number;
  /** A Piper process nobody used for this long is stopped. */
  idleMs: number;
  /** Longest text one request accepts. */
  maxInputChars: number;
  /** Where Piper writes its WAV files; created private to this user. */
  scratchDir: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cpus = os.availableParallelism(),
): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parseInteger("PORT", env.PORT, 5000, 1, 65535),
    piperBin: env.PIPER_BIN || "piper",
    voicesDir: path.resolve(env.PIPER_VOICES_DIR || "/opt/piper-voices"),
    concurrency: parseInteger(
      "PIPER_CONCURRENCY",
      env.PIPER_CONCURRENCY,
      Math.max(1, Math.floor(cpus / 2)),
      1,
      256,
    ),
    timeoutMs: parseInteger("PIPER_TIMEOUT_MS", env.PIPER_TIMEOUT_MS, 120_000, 1000, 3_600_000),
    startupGraceMs: parseInteger(
      "PIPER_STARTUP_GRACE_MS",
      env.PIPER_STARTUP_GRACE_MS,
      60_000,
      0,
      3_600_000,
    ),
    idleMs: parseInteger("PIPER_IDLE_MS", env.PIPER_IDLE_MS, 60_000, 1000, 86_400_000),
    maxInputChars: parseInteger("MAX_INPUT_CHARS", env.MAX_INPUT_CHARS, 1000, 1, 100_000),
    scratchDir: path.resolve(
      env.SCRATCH_DIR || path.join(os.tmpdir(), `piper-api-${process.getuid?.() ?? "user"}`),
    ),
  };
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max) {
    throw new Error(`Invalid ${name} "${value}": expected an integer from ${min} to ${max}`);
  }
  return number;
}
