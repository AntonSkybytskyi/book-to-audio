import path from "node:path";

export interface Config {
  host: string;
  port: number;
  /** Absolute path of the directory holding books, audio and the database. */
  dataDir: string;
  dev: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || "data"),
    // Fail closed: anything but an explicit "development" serves the built app.
    dev: env.NODE_ENV === "development",
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
