import type Database from "better-sqlite3";
import { isLanguage, LANGUAGES, type Language } from "../books/languages.js";
import { MAX_WORKERS } from "@book-to-audio/contracts";

/** English and Ukrainian are shown until the owner changes it; Russian is supported but hidden. */
export const DEFAULT_SHOWN_LANGUAGES: readonly Language[] = ["en", "uk"];

/** Owner-chosen settings, stored as key/value rows. */
export class SettingsStore {
  constructor(private readonly db: Database.Database) {}

  /** The number of workers the owner set for a TTS service, or undefined for the one it reports. */
  workersOverride(service: string): number | undefined {
    const saved = this.read(`workers.${service}`);
    if (saved === undefined) return undefined;
    const value = Number(saved);
    return Number.isInteger(value) ? Math.min(MAX_WORKERS, Math.max(1, value)) : undefined;
  }

  /** Null goes back to the reported number. Throws a RangeError for a value outside 1 to `MAX_WORKERS`. */
  setWorkersOverride(service: string, count: number | null): void {
    if (count === null) {
      this.remove(`workers.${service}`);
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_WORKERS) {
      throw new RangeError(`workers must be a whole number from 1 to ${MAX_WORKERS}`);
    }
    this.write(`workers.${service}`, String(count));
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

  private read(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").pluck().get(key) as
      | string
      | undefined;
  }

  private remove(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
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
