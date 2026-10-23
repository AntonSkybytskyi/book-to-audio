import type Database from "better-sqlite3";
import { isLanguage, LANGUAGES, type Language } from "../books/languages.js";
import type { SettingsView } from "@book-to-audio/contracts";

/** English and Ukrainian are shown until the owner changes it; Russian is supported but hidden. */
export const DEFAULT_SHOWN_LANGUAGES: readonly Language[] = ["en", "uk"];

export interface SettingsOptions {
  /** Number of CPU cores. */
  cpus: number;
  /** `WORKERS` from the environment: replaces the default (never above `cpus`), not a saved choice. */
  envWorkers?: number;
}

/** Owner-chosen settings, stored as key/value rows. */
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

  /** The saved languages of the picker, else English and Ukrainian. */
  shownLanguages(): Language[] {
    const saved = this.read("shown_languages");
    if (saved === undefined) return [...DEFAULT_SHOWN_LANGUAGES];
    try {
      const parsed: unknown = JSON.parse(saved);
      const codes = Array.isArray(parsed) ? parsed.filter(isShownCode) : [];
      return codes.length > 0 ? ordered(codes) : [...DEFAULT_SHOWN_LANGUAGES];
    } catch {
      return [...DEFAULT_SHOWN_LANGUAGES];
    }
  }

  /** Throws a RangeError for an unknown language, or for a list that would hide every language. */
  setShownLanguages(codes: readonly string[]): void {
    if (!codes.every(isLanguage)) throw new RangeError("unknown language");
    if (codes.length === 0) throw new RangeError("at least one language has to stay shown");
    this.write("shown_languages", JSON.stringify(ordered(codes)));
  }

  view(): SettingsView {
    return {
      workers: this.workers(),
      maxWorkers: this.maxWorkers,
      defaultWorkers: this.defaultWorkers,
      shownLanguages: this.shownLanguages(),
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

const isShownCode = (value: unknown): value is Language =>
  typeof value === "string" && isLanguage(value);

/** Without repeats, in the order of `LANGUAGES`. */
const ordered = (codes: readonly Language[]): Language[] =>
  LANGUAGES.filter((code) => codes.includes(code));
