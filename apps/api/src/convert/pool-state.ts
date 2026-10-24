import type Database from "better-sqlite3";
import type { PoolStateName, PauseCause } from "@book-to-audio/contracts";

export interface PoolState {
  state: PoolStateName;
  /** Why the pool paused: about the disk. */
  error: string | null;
  cause: PauseCause | null;
}

export interface ServiceState {
  state: PoolStateName;
  /** Why the service's workers paused: the message of its last failed chapter. */
  error: string | null;
  consecutiveFailures: number;
}

/** Consecutive failed chapters of one TTS service that pause its workers. */
export const FAILURE_LIMIT = 3;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

interface ServiceRow {
  state: PoolStateName;
  error: string | null;
  consecutive_failures: number;
}

/**
 * Whether the pool takes work, kept in SQLite so a pause survives a restart: the whole pool pauses
 * when the disk is nearly full, and each TTS service's workers pause when three of its chapters
 * failed in a row (the circuit breaker), so one broken service does not stop the others.
 */
export class PoolStateStore {
  constructor(private readonly db: Database.Database) {}

  get(): PoolState {
    return this.db
      .prepare("SELECT state, error, cause FROM pool_state WHERE id = 1")
      .get() as PoolState;
  }

  service(id: string): ServiceState {
    const row = this.db
      .prepare("SELECT state, error, consecutive_failures FROM service_state WHERE service = ?")
      .get(id) as ServiceRow | undefined;
    return row
      ? { state: row.state, error: row.error, consecutiveFailures: row.consecutive_failures }
      : { state: "running", error: null, consecutiveFailures: 0 };
  }

  /** Any finished chapter of the service resets its count. */
  recordSuccess(service: string): void {
    this.db
      .prepare("UPDATE service_state SET consecutive_failures = 0 WHERE service = ?")
      .run(service);
  }

  /** Counts a failed chapter. Returns true when this one trips the breaker and pauses the service. */
  recordFailure(service: string, message: string): boolean {
    return this.db
      .transaction(() => {
        const current = this.service(service);
        const failures = current.consecutiveFailures + 1;
        // A chapter that fails after the service paused keeps the first error.
        const trip = current.state === "running" && failures >= FAILURE_LIMIT;
        this.db
          .prepare(
            `INSERT INTO service_state (service, state, error, consecutive_failures)
             VALUES (@service, @state, @error, @failures)
             ON CONFLICT (service) DO UPDATE SET consecutive_failures = @failures,
               state = excluded.state, error = excluded.error, updated_at = ${NOW}`,
          )
          .run({
            service,
            failures,
            state: trip ? "paused" : current.state,
            error: trip ? message : current.error,
          });
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
             updated_at = ${NOW} WHERE id = 1 AND state = 'running'`,
        )
        .run({ cause, message }).changes > 0
    );
  }

  /**
   * Back to running with a clean count: one service, or with no service given the whole pool and
   * every service. Returns false when nothing was paused.
   */
  resume(service?: string): boolean {
    const services = this.db.prepare(
      `UPDATE service_state SET state = 'running', error = NULL, consecutive_failures = 0,
         updated_at = ${NOW} WHERE state = 'paused' AND (@service IS NULL OR service = @service)`,
    );
    const pool = this.db.prepare(
      `UPDATE pool_state SET state = 'running', error = NULL, cause = NULL,
         updated_at = ${NOW} WHERE id = 1 AND state = 'paused'`,
    );
    return this.db
      .transaction(() => {
        const changed = services.run({ service: service ?? null }).changes;
        return changed + (service === undefined ? pool.run().changes : 0) > 0;
      })
      .immediate();
  }
}
