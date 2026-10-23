import type Database from "better-sqlite3";
import type { PoolStateName, PauseCause } from "@book-to-audio/contracts";

export interface PoolState {
  state: PoolStateName;
  /** Why the pool paused: the message of the last failed chapter, or about the disk. */
  error: string | null;
  cause: PauseCause | null;
  consecutiveFailures: number;
}

/** Consecutive failed chapters, across all workers, that pause the pool. */
export const FAILURE_LIMIT = 3;

interface Row {
  state: PoolStateName;
  error: string | null;
  cause: PauseCause | null;
  consecutive_failures: number;
}

/**
 * Whether the pool takes work, kept in SQLite so a pause survives a restart, plus
 * the circuit breaker's count of chapters that failed in a row.
 */
export class PoolStateStore {
  constructor(private readonly db: Database.Database) {}

  get(): PoolState {
    const row = this.db
      .prepare("SELECT state, error, cause, consecutive_failures FROM pool_state WHERE id = 1")
      .get() as Row;
    return {
      state: row.state,
      error: row.error,
      cause: row.cause,
      consecutiveFailures: row.consecutive_failures,
    };
  }

  /** Any finished chapter resets the count. */
  recordSuccess(): void {
    this.db.prepare("UPDATE pool_state SET consecutive_failures = 0 WHERE id = 1").run();
  }

  /** Counts a failed chapter. Returns true when this one trips the breaker and pauses the pool. */
  recordFailure(message: string): boolean {
    return this.db
      .transaction(() => {
        const current = this.get();
        const failures = current.consecutiveFailures + 1;
        // A chapter that fails after the pool paused keeps the first error.
        const trip = current.state === "running" && failures >= FAILURE_LIMIT;
        this.db
          .prepare(
            `UPDATE pool_state SET consecutive_failures = @failures,
               state = CASE WHEN @trip THEN 'paused' ELSE state END,
               error = CASE WHEN @trip THEN @message ELSE error END,
               cause = CASE WHEN @trip THEN 'failures' ELSE cause END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`,
          )
          .run({ failures, trip: trip ? 1 : 0, message });
        return trip;
      })
      .immediate();
  }

  /** Pauses the pool for a reason that is not a chapter's fault. Returns false if already paused. */
  pause(cause: PauseCause, message: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pool_state SET state = 'paused', error = @message, cause = @cause,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1 AND state = 'running'`,
        )
        .run({ cause, message }).changes > 0
    );
  }

  /** Back to running with a clean count. Returns false when it was not paused. */
  resume(): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pool_state SET state = 'running', error = NULL, cause = NULL,
             consecutive_failures = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = 1 AND state = 'paused'`,
        )
        .run().changes > 0
    );
  }
}
