import path from "node:path";

export interface Config {
  host: string;
  port: number;
  /** Absolute path of the directory holding books, audio and the database. */
  dataDir: string;
  /** Largest accepted upload, in megabytes. */
  maxUploadMb: number;
  ttsEngine: "piper" | "fake";
  /** The `piper` executable, a name on PATH or an absolute path. */
  piperBin: string;
  /** Directory with Piper voice models (`.onnx` and `.onnx.json`). */
  piperVoicesDir: string;
  ffmpegBin: string;
  /** The `ffprobe` executable, used to measure chapter files before the M4B is built. */
  ffprobeBin: string;
  /** Opus bitrate of chapter audio, for example `32k`. */
  opusBitrate: string;
  /** AAC bitrate of the M4B audiobook, for example `64k`. */
  m4bBitrate: string;
  /** Host names besides localhost that the app answers to. */
  allowedHosts: string[];
  /** Artificial delay per chunk for the fake engine, to see progress in the UI. */
  fakeTtsDelayMs: number;
  /** Chunks containing this text always fail in the fake engine (development only). */
  fakeTtsFailMarker: string | undefined;
  /** Chunks containing this text always fail as unreadable text, which does not count towards pausing the pool (development only). */
  fakeTtsBadMarker: string | undefined;
  /** Chunks containing this text fail twice, then succeed, in the fake engine (development only). */
  fakeTtsFlakyMarker: string | undefined;
  /** Conversion pauses when less than this many megabytes are free on the data disk. */
  minFreeDiskMb: number;
  /** Default number of workers; a value saved in the settings wins. */
  workers: number | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || "data"),
    maxUploadMb: parseInteger("MAX_UPLOAD_MB", env.MAX_UPLOAD_MB, 200, 1, 10_000),
    ttsEngine: parseEngine(env.TTS_ENGINE),
    piperBin: env.PIPER_BIN || "piper",
    piperVoicesDir: env.PIPER_VOICES_DIR || "/opt/piper-voices",
    ffmpegBin: env.FFMPEG_BIN || "ffmpeg",
    ffprobeBin: env.FFPROBE_BIN || "ffprobe",
    opusBitrate: parseBitrate("OPUS_BITRATE", env.OPUS_BITRATE, "32k"),
    m4bBitrate: parseBitrate("M4B_BITRATE", env.M4B_BITRATE, "64k"),
    allowedHosts: (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    minFreeDiskMb: parseInteger("MIN_FREE_DISK_MB", env.MIN_FREE_DISK_MB, 500, 0, 100_000_000),
    fakeTtsDelayMs: parseInteger("FAKE_TTS_DELAY_MS", env.FAKE_TTS_DELAY_MS, 0, 0, 60_000),
    fakeTtsFailMarker: env.FAKE_TTS_FAIL_MARKER || undefined,
    fakeTtsFlakyMarker: env.FAKE_TTS_FLAKY_MARKER || undefined,
    fakeTtsBadMarker: env.FAKE_TTS_BAD_MARKER || undefined,
    workers: env.WORKERS ? parseInteger("WORKERS", env.WORKERS, 1, 1, 256) : undefined,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer from 1 to 65535`);
  }
  return port;
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

function parseEngine(value: string | undefined): Config["ttsEngine"] {
  if (value === undefined || value === "") return "piper";
  if (value === "piper" || value === "fake") return value;
  throw new Error(`Invalid TTS_ENGINE "${value}": expected "piper" or "fake"`);
}

function parseBitrate(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,3}k$/.test(value)) {
    throw new Error(`Invalid ${name} "${value}": expected a value like "${fallback}"`);
  }
  return value;
}
