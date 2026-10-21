import type Database from "better-sqlite3";

export interface SettingsView {
  workers: number;
  /** Most workers the settings accept. */
  maxWorkers: number;
  /** Used until the owner picks a number. */
  defaultWorkers: number;
}

export interface SettingsOptions {
  /** Number of CPU cores. */
  cpus: number;
  /** `WORKERS` from the environment: replaces the default (never above `cpus`), not a saved choice. */
  envWorkers?: number;
}

/** Owner-chosen settings, stored as key/value rows. Slice 5 adds language settings here. */
export class SettingsStore {
  readonly maxWorkers: number;
  readonly defaultWorkers: number;

  constructor(
    private readonly db: Database.Database,
    { cpus, envWorkers }: SettingsOptions,
  ) {
    this.maxWorkers = Math.max(1, cpus);
    this.defaultWorkers = Math.min(
      this.maxWorkers,
      envWorkers ?? Math.max(1, Math.floor(cpus / 2)),
    );
  }

  /** The saved number of workers, else the default. */
  workers(): number {
    const saved = this.read("workers");
    const value = saved === undefined ? this.defaultWorkers : Number(saved);
    return Number.isInteger(value)
      ? Math.min(this.maxWorkers, Math.max(1, value))
      : this.defaultWorkers;
  }

  /** Throws a RangeError for a value outside 1 to `maxWorkers`. */
  setWorkers(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > this.maxWorkers) {
      throw new RangeError(`workers must be a whole number from 1 to ${this.maxWorkers}`);
    }
    this.write("workers", String(count));
  }

  view(): SettingsView {
    return {
      workers: this.workers(),
      maxWorkers: this.maxWorkers,
      defaultWorkers: this.defaultWorkers,
    };
  }

  private read(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").pluck().get(key) as
      | string
      | undefined;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(key, value);
  }
}
