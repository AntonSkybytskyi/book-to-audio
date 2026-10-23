import path from "node:path";

export interface Config {
  host: string;
  port: number;
  /** Absolute path of the directory holding books, audio and the database. */
  dataDir: string;
  /** Largest accepted upload, in megabytes. */
  maxUploadMb: number;
  /** The TTS services, in the order a language's default voice is looked for. */
  ttsServices: TtsServiceConfig[];
  /** Longest wait for one chunk from a TTS service, time in its queue included. */
  ttsRequestTimeoutMs: number;
  ffmpegBin: string;
  /** The `ffprobe` executable, used to measure chapter files before the M4B is built. */
  ffprobeBin: string;
  /** Opus bitrate of chapter audio, for example `32k`. */
  opusBitrate: string;
  /** AAC bitrate of the M4B audiobook, for example `64k`. */
  m4bBitrate: string;
  /** Host names besides localhost that the app answers to. */
  allowedHosts: string[];
  /** Conversion pauses when less than this many megabytes are free on the data disk. */
  minFreeDiskMb: number;
}

/** One entry of `TTS_SERVICES`. */
export interface TtsServiceConfig {
  /** Goes in front of the service's voice ids, so it is short and has no colon. */
  name: string;
  /** Where the service answers the TTS service API, without a trailing slash. */
  url: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || "data"),
    maxUploadMb: parseInteger("MAX_UPLOAD_MB", env.MAX_UPLOAD_MB, 200, 1, 10_000),
    ttsServices: parseServices(env.TTS_SERVICES),
    ttsRequestTimeoutMs: parseInteger(
      "TTS_REQUEST_TIMEOUT_MS",
      env.TTS_REQUEST_TIMEOUT_MS,
      600_000,
      1000,
      86_400_000,
    ),
    ffmpegBin: env.FFMPEG_BIN || "ffmpeg",
    ffprobeBin: env.FFPROBE_BIN || "ffprobe",
    opusBitrate: parseBitrate("OPUS_BITRATE", env.OPUS_BITRATE, "32k"),
    m4bBitrate: parseBitrate("M4B_BITRATE", env.M4B_BITRATE, "64k"),
    allowedHosts: (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    minFreeDiskMb: parseInteger("MIN_FREE_DISK_MB", env.MIN_FREE_DISK_MB, 500, 0, 100_000_000),
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

const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** `name=url,name=url`, for example `piper=http://piper-api:5000`. */
function parseServices(value: string | undefined): TtsServiceConfig[] {
  const example = 'for example "piper=http://piper-api:5000"';
  if (!value?.trim()) {
    throw new Error(`TTS_SERVICES is not set: list the TTS services as name=url, ${example}`);
  }
  const services: TtsServiceConfig[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    const [rawName = "", ...rest] = entry.split("=");
    const name = rawName.trim();
    const url = rest.join("=").trim();
    const invalid = (why: string) => new Error(`Invalid TTS_SERVICES entry "${entry}": ${why}`);
    if (!SERVICE_NAME.test(name)) {
      throw invalid(`the name must be lowercase letters, digits, - or _, ${example}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid(`expected name=url, ${example}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw invalid("the url must be http or https");
    }
    if (services.some((service) => service.name === name)) {
      throw new Error(`Invalid TTS_SERVICES: "${name}" is listed twice`);
    }
    services.push({ name, url: url.replace(/\/+$/, "") });
  }
  return services;
}

function parseBitrate(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,3}k$/.test(value)) {
    throw new Error(`Invalid ${name} "${value}": expected a value like "${fallback}"`);
  }
  return value;
}
